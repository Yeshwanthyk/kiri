use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{connect, Message};

#[test]
fn websocket_sends_snapshot_and_streams_shell_output() {
    with_daemon(|state_dir| run_ws_smoke(state_dir));
}

#[test]
fn control_routes_read_input_resize_and_kill_shell_session() {
    with_daemon(run_control_smoke);
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

fn poll_read_contains(record: &Value, cursor: Option<&str>, needle: &str) -> Result<Value, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let body = match cursor {
            Some(cursor) => json!({ "key": "proj-t1:shell", "cursor": cursor }),
            None => json!({ "key": "proj-t1:shell" }),
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
    let body = json!({
        "config": {
            "id": "agent-t1",
            "projectId": "proj-t1",
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
    let path = std::env::temp_dir().join(format!("kiri-termd-ws-{id}"));
    fs::create_dir_all(&path).expect("temp state dir should be created");
    path
}
