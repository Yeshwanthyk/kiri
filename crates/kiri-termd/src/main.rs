mod grid;

use anyhow::{Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{SinkExt, StreamExt};
use grid::Grid;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex, RwLock},
};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{error, warn};

const DAEMON_PATH: &str = "/terminal";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct AppState {
    token: String,
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    launch_configs: Arc<RwLock<HashMap<String, LaunchConfig>>>,
}

struct Session {
    key: String,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    grid: Mutex<Grid>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    _child: Mutex<Box<dyn Child + Send + Sync>>,
    exited: AtomicBool,
    output_seq: AtomicU64,
    tx: broadcast::Sender<SessionEvent>,
}

#[derive(Deserialize)]
struct TerminalQuery {
    token: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    mode: String,
    cols: Option<u16>,
    rows: Option<u16>,
    #[serde(rename = "termId")]
    term_id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerFrame {
    Snapshot {
        data: String,
        cols: u16,
        rows: u16,
        generation: u64,
    },
    Data {
        data: String,
    },
    Exit {
        message: String,
    },
}

#[derive(Clone, Debug)]
enum SessionEvent {
    Data { seq: u64, data: String },
    Exit { message: String },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientFrame {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Ack { bytes: u64 },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchConfig {
    id: String,
    project_id: String,
    cwd: String,
}

#[derive(Deserialize)]
struct UpsertAgentRequest {
    config: LaunchConfig,
}

#[derive(Serialize)]
struct DaemonRecord {
    pid: u32,
    host: String,
    port: u16,
    path: String,
    token: String,
    version: String,
    #[serde(rename = "startedAt")]
    started_at: String,
}

#[derive(Serialize)]
struct HealthPayload {
    ok: bool,
    pid: u32,
    version: String,
    sessions: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let state_dir = state_dir();
    fs::create_dir_all(&state_dir).context("failed to create kiriterm state dir")?;
    let _lock = DaemonLock::acquire(state_dir.join("daemon.lock"))?;
    let token = token();
    let state = AppState {
        token: token.clone(),
        sessions: Arc::new(RwLock::new(HashMap::new())),
        launch_configs: Arc::new(RwLock::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/agents/upsert", post(upsert_agent))
        .route(DAEMON_PATH, get(terminal_ws))
        .with_state(state.clone());
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("failed to bind kiri-termd")?;
    let port = listener.local_addr()?.port();
    write_record(&state_dir, &token, port)?;
    axum::serve(listener, app)
        .await
        .context("kiri-termd server failed")
}

async fn health(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(
        &state.token,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    ) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response();
    }
    let sessions = state.sessions.read().await.len();
    Json(HealthPayload {
        ok: true,
        pid: process::id(),
        version: VERSION.to_string(),
        sessions,
    })
    .into_response()
}

async fn upsert_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpsertAgentRequest>,
) -> impl IntoResponse {
    if !authorized(
        &state.token,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    ) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response();
    }
    state
        .launch_configs
        .write()
        .await
        .insert(body.config.id.clone(), body.config);
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn terminal_ws(
    State(state): State<AppState>,
    Query(query): Query<TerminalQuery>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    if !constant_time_eq(query.token.as_bytes(), state.token.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    upgrade.on_upgrade(move |socket| handle_socket(state, query, socket))
}

async fn handle_socket(state: AppState, query: TerminalQuery, socket: WebSocket) {
    let session = match get_or_spawn_session(&state, &query).await {
        Ok(session) => session,
        Err(error) => {
            let (mut sender, _) = socket.split();
            let _ = sender
                .send(Message::Text(frame_text(&ServerFrame::Exit {
                    message: error.to_string(),
                })))
                .await;
            return;
        }
    };

    let mut stream = BroadcastStream::new(session.tx.subscribe());
    let (cols, rows, snapshot, snapshot_seq) = {
        let grid = session.grid.lock().await;
        let cols = grid.cols() as u16;
        let rows = grid.rows() as u16;
        let snapshot = grid.serialize_ansi();
        let snapshot_seq = session.output_seq.load(Ordering::SeqCst);
        (cols, rows, snapshot, snapshot_seq)
    };
    let (mut sender, mut receiver) = socket.split();
    if sender
        .send(Message::Text(frame_text(&ServerFrame::Snapshot {
            data: snapshot,
            cols,
            rows,
            generation: 0,
        })))
        .await
        .is_err()
    {
        return;
    }

    let output_task = tokio::spawn(async move {
        while let Some(event) = stream.next().await {
            let Ok(event) = event else {
                continue;
            };
            let frame = match event {
                SessionEvent::Data { seq, data } => {
                    if seq <= snapshot_seq {
                        continue;
                    }
                    ServerFrame::Data { data }
                }
                SessionEvent::Exit { message } => ServerFrame::Exit { message },
            };
            if sender
                .send(Message::Text(frame_text(&frame)))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<ClientFrame>(&text) else {
            continue;
        };
        match frame {
            ClientFrame::Input { data } => {
                let mut writer = session.writer.lock().await;
                if writer.write_all(data.as_bytes()).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            ClientFrame::Resize { cols, rows } => {
                *session.cols.lock().await = cols;
                *session.rows.lock().await = rows;
                session
                    .grid
                    .lock()
                    .await
                    .resize(usize::from(cols), usize::from(rows));
                if let Err(error) = session.master.lock().await.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }) {
                    warn!("failed to resize pty for {}: {error}", session.key);
                }
            }
            ClientFrame::Ack { bytes } => {
                let _ = bytes;
            }
        }
    }
    output_task.abort();
}

async fn get_or_spawn_session(state: &AppState, query: &TerminalQuery) -> Result<Arc<Session>> {
    let config = state
        .launch_configs
        .read()
        .await
        .get(&query.agent_id)
        .cloned();
    let key = session_key(query, config.as_ref());
    if let Some(session) = state.sessions.read().await.get(&key).cloned() {
        if !session.exited.load(Ordering::SeqCst) {
            return Ok(session);
        }
    }
    let mut sessions = state.sessions.write().await;
    if let Some(session) = sessions.get(&key).cloned() {
        if !session.exited.load(Ordering::SeqCst) {
            return Ok(session);
        }
        sessions.remove(&key);
    }
    let cwd = config
        .as_ref()
        .map(|config| config.cwd.clone())
        .unwrap_or_else(|| {
            env::current_dir()
                .map(|cwd| cwd.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".to_string())
        });
    let (session, reader) = spawn_shell_session(
        key.clone(),
        query.mode.clone(),
        cwd,
        query.cols.unwrap_or(80),
        query.rows.unwrap_or(24),
    )?;
    let session = Arc::new(session);
    start_reader(session.clone(), reader);
    sessions.insert(key, session.clone());
    Ok(session)
}

fn spawn_shell_session(
    key: String,
    mode: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(Session, Box<dyn Read + Send>)> {
    if mode != "shell" {
        anyhow::bail!("kiri-termd P0 supports shell sessions only")
    }
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open pty")?;
    let mut command = CommandBuilder::new(shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn shell")?;
    drop(pair.slave);
    let writer = pair
        .master
        .take_writer()
        .context("failed to open pty writer")?;
    let reader = pair
        .master
        .try_clone_reader()
        .context("failed to clone pty reader")?;
    let (tx, _) = broadcast::channel(16_384);
    Ok((
        Session {
            key,
            cols: Mutex::new(cols),
            rows: Mutex::new(rows),
            grid: Mutex::new(Grid::new(usize::from(cols), usize::from(rows))),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            _child: Mutex::new(child),
            exited: AtomicBool::new(false),
            output_seq: AtomicU64::new(0),
            tx,
        },
        reader,
    ))
}

fn start_reader(session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let bytes = &buffer[..read];
                    let text = decode_utf8_chunk(&mut pending_utf8, bytes);
                    let session = session.clone();
                    tokio::runtime::Handle::current().block_on(async move {
                        let seq = {
                            let mut grid = session.grid.lock().await;
                            grid.feed(bytes);
                            session.output_seq.fetch_add(1, Ordering::SeqCst) + 1
                        };
                        if !text.is_empty() {
                            let _ = session.tx.send(SessionEvent::Data { seq, data: text });
                        }
                    });
                }
                Err(error) => {
                    error!("pty reader failed for {}: {error}", session.key);
                    break;
                }
            }
        }
        session.exited.store(true, Ordering::SeqCst);
        let _ = session.tx.send(SessionEvent::Exit {
            message: "terminal process exited".to_string(),
        });
    });
}

fn session_key(query: &TerminalQuery, config: Option<&LaunchConfig>) -> String {
    if query.mode == "shell" {
        let project_id = config
            .map(|config| config.project_id.as_str())
            .unwrap_or(query.agent_id.as_str());
        match &query.term_id {
            Some(term_id) if !term_id.is_empty() => format!("{project_id}:shell:{term_id}"),
            _ => format!("{project_id}:shell"),
        }
    } else {
        format!("{}:runtime", query.agent_id)
    }
}

fn decode_utf8_chunk(pending: &mut Vec<u8>, bytes: &[u8]) -> String {
    pending.extend_from_slice(bytes);
    match String::from_utf8(std::mem::take(pending)) {
        Ok(text) => text,
        Err(error) => {
            let bytes = error.into_bytes();
            let valid_up_to = std::str::from_utf8(&bytes)
                .err()
                .map(|error| error.valid_up_to())
                .unwrap_or(bytes.len());
            let mut output = String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned();
            pending.extend_from_slice(&bytes[valid_up_to..]);
            if pending.len() > 4 {
                output.push_str(&String::from_utf8_lossy(pending));
                pending.clear();
            }
            output
        }
    }
}

fn frame_text(frame: &ServerFrame) -> String {
    serde_json::to_string(frame).expect("server frame should serialize")
}

fn state_dir() -> PathBuf {
    env::var_os("KIRI_TERM_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            home.join(".kiri").join("kiriterm")
        })
}

fn write_record(state_dir: &PathBuf, token: &str, port: u16) -> Result<()> {
    let record = DaemonRecord {
        pid: process::id(),
        host: "127.0.0.1".to_string(),
        port,
        path: DAEMON_PATH.to_string(),
        token: token.to_string(),
        version: VERSION.to_string(),
        started_at: iso_now(),
    };
    let path = state_dir.join("daemon.json");
    fs::write(path, serde_json::to_vec_pretty(&record)?).context("failed to write daemon record")
}

fn token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn iso_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}")
}

fn authorized(token: &str, authorization: Option<&str>) -> bool {
    let Some(value) = authorization else {
        return false;
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(candidate.as_bytes(), token.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

struct DaemonLock {
    path: PathBuf,
}

impl DaemonLock {
    fn acquire(path: PathBuf) -> Result<Self> {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                writeln!(
                    file,
                    "{{\"pid\":{},\"createdAtMs\":{}}}",
                    process::id(),
                    epoch_ms()
                )?;
                Ok(Self { path })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if stale_lock(&path) {
                    let _ = fs::remove_file(&path);
                    return Self::acquire(path);
                }
                anyhow::bail!("kiriterm daemon is already starting")
            }
            Err(error) => Err(error).context("failed to acquire daemon lock"),
        }
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn stale_lock(path: &PathBuf) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|elapsed| elapsed > Duration::from_millis(8_000))
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
