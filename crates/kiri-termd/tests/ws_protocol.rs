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
    let state_dir = temp_state_dir();
    let mut child = Command::new(env!("CARGO_BIN_EXE_kiri-termd"))
        .env("KIRI_TERM_STATE_DIR", &state_dir)
        .spawn()
        .expect("kiri-termd should spawn");

    let result = run_ws_smoke(&state_dir);
    let _ = child.kill();
    let _ = child.wait();
    let _ = fs::remove_dir_all(&state_dir);

    result.expect("websocket smoke should pass");
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
    let (mut socket, _) = connect(url).map_err(|error| error.to_string())?;
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
    let host = record["host"].as_str().unwrap();
    let port = record["port"].as_u64().unwrap();
    let token = record["token"].as_str().unwrap();
    let request = format!(
        "POST /api/agents/upsert HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect((host, port as u16)).map_err(|error| error.to_string())?;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.1 200") {
        Ok(())
    } else {
        Err(response)
    }
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
