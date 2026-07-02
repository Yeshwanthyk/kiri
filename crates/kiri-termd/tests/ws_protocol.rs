use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{connect, Message};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn websocket_sends_snapshot_and_streams_shell_output() {
    with_daemon(|state_dir| run_ws_smoke(state_dir));
}

#[test]
fn control_routes_read_input_resize_and_kill_shell_session() {
    with_daemon(run_control_smoke);
}

#[test]
fn wait_routes_match_screen_output_and_idle_targets() {
    with_daemon(run_wait_smoke);
}

#[test]
fn shutdown_route_stops_daemon_and_removes_record() {
    let state_dir = temp_state_dir();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kiri-termd"))
        .env("KIRI_TERM_STATE_DIR", &state_dir)
        .spawn()
        .expect("kiri-termd should spawn");

    let result = run_shutdown_smoke(&state_dir, &mut child);
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&state_dir);

    result.expect("shutdown smoke should pass");
}

#[test]
fn persisted_shell_snapshot_restores_after_daemon_restart() {
    let state_dir = temp_state_dir();
    let mut first = Command::new(env!("CARGO_BIN_EXE_kiri-termd"))
        .env("KIRI_TERM_STATE_DIR", &state_dir)
        .spawn()
        .expect("first kiri-termd should spawn");

    let result = run_restart_restore_smoke(&state_dir, &mut first);
    let _ = first.kill();
    let _ = first.wait();
    let _ = fs::remove_dir_all(&state_dir);

    result.expect("restart restore smoke should pass");
}

fn with_daemon(run: impl FnOnce(&Path) -> Result<(), String>) {
    let state_dir = temp_state_dir();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kiri-termd"))
        .env("KIRI_TERM_STATE_DIR", &state_dir)
        .spawn()
        .expect("kiri-termd should spawn");

    let result = run(&state_dir);
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&state_dir);

    result.expect("daemon smoke should pass");
}

fn run_ws_smoke(state_dir: &Path) -> Result<(), String> {
    let record = wait_record(state_dir)?;
    post_upsert(&record, state_dir)?;
    let url = format!(
        "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let snapshot = read_json_frame(&mut socket, Duration::from_secs(5))?;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["cols"], 80);
    assert_eq!(snapshot["rows"], 24);

    socket
        .send(Message::Text(
            json!({ "type": "input", "data": "printf 'ws-protocol-%s\\n' ok\r" }).to_string(),
        ))
        .map_err(|error| error.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let frame = read_json_frame(&mut socket, Duration::from_secs(1))?;
        if frame["type"] == "data"
            && frame["data"]
                .as_str()
                .is_some_and(|data| data.contains("ws-protocol-ok"))
        {
            return Ok(());
        }
    }
    Err("timed out waiting for shell output".to_string())
}

fn run_control_smoke(state_dir: &Path) -> Result<(), String> {
    let record = wait_record(state_dir)?;
    post_upsert(&record, state_dir)?;
    let url = format!(
        "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let snapshot = read_json_frame(&mut socket, Duration::from_secs(5))?;
    assert_eq!(snapshot["type"], "snapshot");

    let sessions = http_json(&record, "GET", "/api/sessions", None)?;
    assert_eq!(sessions["sessions"][0]["key"], "proj-t1:shell");
    assert_eq!(sessions["sessions"][0]["attachedClients"], 1);

    let first_read = http_json(
        &record,
        "POST",
        "/api/sessions/read",
        Some(json!({ "key": "proj-t1:shell" })),
    )?;
    assert_eq!(first_read["output"], "");
    let first_cursor = first_read["cursor"].as_str().unwrap().to_string();

    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'control-route-%s\\n' ok",
            "keys": ["enter"]
        })),
    )?;
    let control_read = poll_read_contains(&record, None, "control-route-ok")?;
    assert!(control_read["screen"]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line.as_str().unwrap_or("").contains("control-route-ok")));

    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'delta-route-%s\\n' ok",
            "keys": ["enter"]
        })),
    )?;
    let delta_read = poll_read_contains(&record, Some(&first_cursor), "delta-route-ok")?;
    let output = delta_read["output"].as_str().unwrap();
    assert!(output.contains("control-route-ok"));
    assert!(output.contains("delta-route-ok"));

    let cursor = control_read["cursor"].as_str().unwrap();
    let later_read = poll_read_contains(&record, Some(cursor), "delta-route-ok")?;
    let later_output = later_read["output"].as_str().unwrap();
    assert!(!later_output.contains("control-route-ok"));
    assert!(later_output.contains("delta-route-ok"));

    let snapshot = http_json(
        &record,
        "POST",
        "/api/sessions/snapshot",
        Some(json!({ "key": "proj-t1:shell" })),
    )?;
    assert!(snapshot["snapshot"]
        .as_str()
        .is_some_and(|snapshot| snapshot.contains("delta-route-ok")));

    http_json(
        &record,
        "POST",
        "/api/sessions/resize",
        Some(json!({ "key": "proj-t1:shell", "cols": 100, "rows": 25 })),
    )?;
    let resized = http_json(
        &record,
        "POST",
        "/api/sessions/read",
        Some(json!({ "key": "proj-t1:shell" })),
    )?;
    assert_eq!(resized["screen"]["cols"], 100);
    assert_eq!(resized["screen"]["rows"], 25);

    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf '\\033[?1049halt-screen\\n'\r"
        })),
    )?;
    let alt_read = poll_read_buffer_type(&record, "alternate")?;
    assert_eq!(alt_read["screen"]["bufferType"], "alternate");
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf '\\033[?1049l'\r"
        })),
    )?;

    let killed = http_json(
        &record,
        "POST",
        "/api/sessions/kill-prefix",
        Some(json!({ "keyPrefix": "proj-t1" })),
    )?;
    assert_eq!(killed["killed"], 1);
    let after_kill = http_json(&record, "GET", "/api/sessions", None)?;
    assert_eq!(after_kill["sessions"].as_array().unwrap().len(), 0);
    let read_dead = http_status(
        &record,
        "POST",
        "/api/sessions/read",
        Some(json!({ "key": "proj-t1:shell" })),
    )?;
    assert!(read_dead.starts_with("HTTP/1.1 404"));
    let _ = socket.close(None);

    let (mut replacement_socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let replacement_snapshot = read_json_frame(&mut replacement_socket, Duration::from_secs(5))?;
    assert_eq!(replacement_snapshot["generation"], 1);
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'replacement-%s\\n' ok",
            "keys": ["enter"]
        })),
    )?;
    let replacement_read = poll_read_contains(&record, Some(cursor), "replacement-ok")?;
    let replacement_output = replacement_read["output"].as_str().unwrap();
    assert!(replacement_output.contains("replacement-ok"));
    let _ = replacement_socket.close(None);
    Ok(())
}

fn run_wait_smoke(state_dir: &Path) -> Result<(), String> {
    let record = wait_record(state_dir)?;
    post_upsert(&record, state_dir)?;
    let url = format!(
        "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let snapshot = read_json_frame(&mut socket, Duration::from_secs(5))?;
    assert_eq!(snapshot["type"], "snapshot");

    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'wait-screen-%s\\n' ok",
            "keys": ["enter"]
        })),
    )?;
    let waited = http_json(
        &record,
        "POST",
        "/api/sessions/wait-for",
        Some(json!({
            "key": "proj-t1:shell",
            "pattern": "WAIT-SCREEN-ok",
            "flags": "i",
            "timeoutMs": 5000
        })),
    )?;
    assert_eq!(waited["matched"], true);
    assert_eq!(waited["match"], "wait-screen-ok");

    let output_waited = http_json(
        &record,
        "POST",
        "/api/sessions/wait-for",
        Some(json!({
            "key": "proj-t1:shell",
            "pattern": "printf 'wait-screen",
            "scope": "output",
            "timeoutMs": 5000
        })),
    )?;
    assert_eq!(output_waited["matched"], true);

    let missing_any = http_json(
        &record,
        "POST",
        "/api/sessions/wait-any",
        Some(json!({
            "targets": [
                { "key": "missing:shell", "pattern": "never" },
                { "key": "proj-t1:shell", "label": "Shell", "pattern": "wait-screen-ok" }
            ],
            "timeoutMs": 5000,
            "quorum": "any"
        })),
    )?;
    assert_eq!(missing_any["matched"], true);
    assert_eq!(missing_any["matches"][0]["key"], "proj-t1:shell");
    assert_eq!(missing_any["matches"][0]["label"], "Shell");
    assert_eq!(missing_any["missing"][0], "missing:shell");

    let multi_ready_any = http_json(
        &record,
        "POST",
        "/api/sessions/wait-any",
        Some(json!({
            "targets": [
                { "key": "proj-t1:shell", "pattern": "wait-screen-ok" },
                { "key": "proj-t1:shell", "pattern": "wait-screen" }
            ],
            "timeoutMs": 5000,
            "quorum": "any"
        })),
    )?;
    assert_eq!(multi_ready_any["matched"], true);
    assert_eq!(multi_ready_any["matches"].as_array().unwrap().len(), 1);

    post_upsert_agent(&record, "agent-t2", "proj-t2", state_dir)?;
    let second_url = format!(
        "ws://{}:{}{}?agentId=agent-t2&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut second_socket, _) = connect(&second_url).map_err(|error| error.to_string())?;
    let second_snapshot = read_json_frame(&mut second_socket, Duration::from_secs(5))?;
    assert_eq!(second_snapshot["type"], "snapshot");
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'first-live-winner\\n'",
            "keys": ["enter"]
        })),
    )?;
    poll_read_contains(&record, None, "first-live-winner")?;
    std::thread::sleep(Duration::from_millis(80));
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t2:shell",
            "data": "printf 'second-live-winner\\n'",
            "keys": ["enter"]
        })),
    )?;
    poll_read_key_contains(&record, "proj-t2:shell", None, "second-live-winner")?;
    let two_live_any = http_json(
        &record,
        "POST",
        "/api/sessions/wait-any",
        Some(json!({
            "targets": [
                { "key": "proj-t2:shell", "pattern": "second-live-winner" },
                { "key": "proj-t1:shell", "pattern": "first-live-winner" }
            ],
            "timeoutMs": 5000,
            "quorum": "any"
        })),
    )?;
    assert_eq!(two_live_any["matched"], true);
    assert_eq!(two_live_any["matches"].as_array().unwrap().len(), 1);
    assert_eq!(two_live_any["matches"][0]["key"], "proj-t1:shell");
    let _ = second_socket.close(None);

    let all_wait = http_json(
        &record,
        "POST",
        "/api/sessions/wait-any",
        Some(json!({
            "targets": [
                { "key": "proj-t1:shell", "pattern": "wait-screen-ok" },
                { "key": "proj-t1:shell", "idleMs": 250 }
            ],
            "timeoutMs": 5000,
            "quorum": "all"
        })),
    )?;
    assert_eq!(all_wait["matched"], true);
    assert_eq!(all_wait["matches"].as_array().unwrap().len(), 2);
    assert!(all_wait["matches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["idle"] == true));

    let timeout = http_json(
        &record,
        "POST",
        "/api/sessions/wait-for",
        Some(json!({
            "key": "proj-t1:shell",
            "pattern": "definitely-not-present",
            "timeoutMs": 250
        })),
    )?;
    assert_eq!(timeout["matched"], false);

    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({ "key": "proj-t1:shell", "data": "exit\r" })),
    )?;
    poll_session_exited(&record, "proj-t1:shell")?;
    let dead_wait = http_json(
        &record,
        "POST",
        "/api/sessions/wait-for",
        Some(json!({
            "key": "proj-t1:shell",
            "pattern": "wait-screen-ok",
            "timeoutMs": 500
        })),
    )?;
    assert_eq!(dead_wait["matched"], false);
    let _ = socket.close(None);

    let (mut replacement_socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let replacement_snapshot = read_json_frame(&mut replacement_socket, Duration::from_secs(5))?;
    assert_eq!(replacement_snapshot["generation"], 1);
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'replacement-wait-%s\\n' ok",
            "keys": ["enter"]
        })),
    )?;
    let replacement_wait = http_json(
        &record,
        "POST",
        "/api/sessions/wait-for",
        Some(json!({
            "key": "proj-t1:shell",
            "pattern": "replacement-wait-ok",
            "timeoutMs": 5000
        })),
    )?;
    assert_eq!(replacement_wait["matched"], true);
    let _ = replacement_socket.close(None);
    Ok(())
}

fn run_shutdown_smoke(state_dir: &Path, child: &mut std::process::Child) -> Result<(), String> {
    let record = wait_record(state_dir)?;
    post_upsert(&record, state_dir)?;
    let url = format!(
        "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let snapshot = read_json_frame(&mut socket, Duration::from_secs(5))?;
    assert_eq!(snapshot["type"], "snapshot");
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "sleep 99999\r"
        })),
    )?;
    http_json(&record, "POST", "/api/shutdown", Some(json!({})))?;
    read_until_frame_type(&mut socket, "exit", Duration::from_secs(5))?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
            && !state_dir.join("daemon.json").exists()
        {
            let _ = socket.close(None);
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("daemon did not shut down and remove daemon.json".to_string())
}

fn run_restart_restore_smoke(
    state_dir: &Path,
    first: &mut std::process::Child,
) -> Result<(), String> {
    let record = wait_record(state_dir)?;
    post_upsert(&record, state_dir)?;
    let url = format!(
        "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
        record["host"].as_str().unwrap(),
        record["port"].as_u64().unwrap(),
        record["path"].as_str().unwrap(),
        record["token"].as_str().unwrap()
    );
    let (mut socket, _) = connect(&url).map_err(|error| error.to_string())?;
    let snapshot = read_json_frame(&mut socket, Duration::from_secs(5))?;
    assert_eq!(snapshot["type"], "snapshot");
    http_json(
        &record,
        "POST",
        "/api/sessions/input",
        Some(json!({
            "key": "proj-t1:shell",
            "data": "printf 'persisted-shell-snapshot\\n'",
            "keys": ["enter"]
        })),
    )?;
    poll_read_contains(&record, None, "persisted-shell-snapshot")?;
    http_json(&record, "POST", "/api/shutdown", Some(json!({})))?;
    let _ = socket.close(None);
    wait_child_exit_and_record_removed(state_dir, first)?;

    let persisted_path = state_dir.join("sessions").join("proj-t1%3Ashell.json");
    let persisted = fs::read_to_string(&persisted_path).map_err(|error| error.to_string())?;
    assert!(persisted.contains("persisted-shell-snapshot"));

    let mut second = Command::new(env!("CARGO_BIN_EXE_kiri-termd"))
        .env("KIRI_TERM_STATE_DIR", state_dir)
        .spawn()
        .map_err(|error| error.to_string())?;
    let second_result = (|| {
        let record = wait_record(state_dir)?;
        post_upsert(&record, state_dir)?;
        let url = format!(
            "ws://{}:{}{}?agentId=agent-t1&mode=shell&cols=80&rows=24&token={}",
            record["host"].as_str().unwrap(),
            record["port"].as_u64().unwrap(),
            record["path"].as_str().unwrap(),
            record["token"].as_str().unwrap()
        );
        let (mut restored_socket, _) = connect(&url).map_err(|error| error.to_string())?;
        let restored_snapshot = read_json_frame(&mut restored_socket, Duration::from_secs(5))?;
        let data = restored_snapshot["data"].as_str().unwrap_or("");
        assert!(data.contains("persisted-shell-snapshot"));
        assert!(data.contains("[kiriterm: restored scrollback from previous session]"));
        let _ = restored_socket.close(None);
        http_json(&record, "POST", "/api/shutdown", Some(json!({})))?;
        wait_child_exit_and_record_removed(state_dir, &mut second)
    })();
    let _ = second.kill();
    let _ = second.wait();
    second_result
}

fn wait_child_exit_and_record_removed(
    state_dir: &Path,
    child: &mut std::process::Child,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
            && !state_dir.join("daemon.json").exists()
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("daemon did not exit and remove daemon.json".to_string())
}

fn poll_session_exited(record: &Value, key: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let sessions = http_json(record, "GET", "/api/sessions", None)?;
        if sessions["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|session| session["key"] == key && session["exited"] == true)
        {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for session {key} to exit"))
}

fn poll_read_contains(record: &Value, cursor: Option<&str>, needle: &str) -> Result<Value, String> {
    poll_read_key_contains(record, "proj-t1:shell", cursor, needle)
}

fn poll_read_key_contains(
    record: &Value,
    key: &str,
    cursor: Option<&str>,
    needle: &str,
) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let body = match cursor {
            Some(cursor) => json!({ "key": key, "cursor": cursor }),
            None => json!({ "key": key }),
        };
        let read = http_json(record, "POST", "/api/sessions/read", Some(body))?;
        if read.to_string().contains(needle) {
            return Ok(read);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for {needle}"))
}

fn poll_read_buffer_type(record: &Value, buffer_type: &str) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let read = http_json(
            record,
            "POST",
            "/api/sessions/read",
            Some(json!({ "key": "proj-t1:shell" })),
        )?;
        if read["screen"]["bufferType"] == buffer_type {
            return Ok(read);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for bufferType {buffer_type}"))
}

fn post_upsert(record: &Value, state_dir: &Path) -> Result<(), String> {
    post_upsert_agent(record, "agent-t1", "proj-t1", state_dir)
}

fn post_upsert_agent(
    record: &Value,
    agent_id: &str,
    project_id: &str,
    state_dir: &Path,
) -> Result<(), String> {
    let body = json!({
        "config": {
            "id": agent_id,
            "projectId": project_id,
            "runtime": "codex",
            "sessionDir": state_dir,
            "sessionFile": null,
            "model": "",
            "cwd": state_dir,
            "runtimeStateJson": null
        }
    })
    .to_string();
    http_json(
        record,
        "POST",
        "/api/agents/upsert",
        Some(serde_json::from_str(&body).unwrap()),
    )?;
    Ok(())
}

fn http_json(
    record: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let host = record["host"].as_str().unwrap();
    let port = record["port"].as_u64().unwrap();
    let token = record["token"].as_str().unwrap();
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    let request = if body.is_empty() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    };
    let mut stream = TcpStream::connect((host, port as u16)).map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if !response.starts_with("HTTP/1.1 200") {
        return Err(response);
    }
    let (_, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| format!("malformed HTTP response: {response}"))?;
    serde_json::from_str(body).map_err(|error| error.to_string())
}

fn http_status(
    record: &Value,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<String, String> {
    let host = record["host"].as_str().unwrap();
    let port = record["port"].as_u64().unwrap();
    let token = record["token"].as_str().unwrap();
    let body = body.map(|body| body.to_string()).unwrap_or_default();
    let request = if body.is_empty() {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    };
    let mut stream = TcpStream::connect((host, port as u16)).map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(response)
}

fn read_json_frame(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            return Err("timed out waiting for websocket frame".to_string());
        }
        let message = socket.read().map_err(|error| error.to_string())?;
        if let Message::Text(text) = message {
            return serde_json::from_str(&text).map_err(|error| error.to_string());
        }
    }
}

fn read_until_frame_type(
    socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>,
    frame_type: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() > deadline {
            return Err(format!("timed out waiting for {frame_type} frame"));
        }
        let frame = read_json_frame(socket, Duration::from_secs(1))?;
        if frame["type"] == frame_type {
            return Ok(frame);
        }
    }
}

fn wait_record(state_dir: &Path) -> Result<Value, String> {
    let path = state_dir.join("daemon.json");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(contents) = fs::read_to_string(&path) {
            return serde_json::from_str(&contents).map_err(|error| error.to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("daemon record was not written".to_string())
}

fn temp_state_dir() -> PathBuf {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
    let path = std::env::temp_dir().join(format!(
        "kiri-termd-ws-{}-{id}-{counter}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("temp state dir should be created");
    path
}
