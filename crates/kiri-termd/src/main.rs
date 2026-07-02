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
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex as StdMutex, Weak,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex, RwLock},
};
use tokio_stream::wrappers::BroadcastStream;
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};

const DAEMON_PATH: &str = "/terminal";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_RECENT_OUTPUT_BYTES: usize = 64_000;
const DEFAULT_IDLE_KILL_MS: u64 = 5 * 60 * 1000;
const FLOW_HIGH_WATERMARK_BYTES: usize = 256_000;
const FLOW_LOW_WATERMARK_BYTES: usize = 64_000;

#[derive(Clone)]
struct AppState {
    token: String,
    record_path: PathBuf,
    sessions_dir: PathBuf,
    idle_kill_ms: u64,
    shutdown: CancellationToken,
    sessions: Arc<RwLock<HashMap<String, Arc<Session>>>>,
    generations: Arc<RwLock<HashMap<String, u64>>>,
    launch_configs: Arc<RwLock<HashMap<String, LaunchConfig>>>,
    pending_inputs: Arc<RwLock<HashMap<String, Vec<PendingInput>>>>,
    restored_sessions: Arc<Mutex<HashMap<String, PersistedSession>>>,
}

struct Session {
    key: String,
    mode: String,
    label: String,
    cwd: String,
    cols: Mutex<u16>,
    rows: Mutex<u16>,
    grid: Mutex<Grid>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    exited: AtomicBool,
    generation: AtomicU64,
    output_seq: AtomicU64,
    last_output_at_ms: AtomicU64,
    recent_output: Mutex<Vec<OutputChunk>>,
    attached_clients: AtomicUsize,
    idle_epoch: AtomicU64,
    flow_control: FlowControl,
    client_flows: StdMutex<Vec<Weak<ClientFlow>>>,
    tx: broadcast::Sender<SessionEvent>,
}

#[derive(Clone)]
struct OutputChunk {
    seq: u64,
    data: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct PersistedSession {
    key: String,
    mode: String,
    label: String,
    cwd: String,
    cols: u16,
    rows: u16,
    snapshot: String,
    #[serde(rename = "savedAt")]
    saved_at: String,
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
    runtime: String,
    session_dir: String,
    session_file: Option<String>,
    model: String,
    cwd: String,
    runtime_state_json: Option<String>,
}

#[derive(Deserialize)]
struct UpsertAgentRequest {
    config: LaunchConfig,
    #[serde(rename = "pendingInputs", default)]
    pending_inputs: Vec<PendingInput>,
}

#[allow(dead_code)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingInput {
    text: String,
    submit: bool,
    created_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdRequest {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnAgentRequest {
    agent_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInputRequest {
    agent_id: String,
    text: String,
    #[serde(default = "default_submit")]
    submit: bool,
}

#[derive(Deserialize)]
struct SessionKeyRequest {
    key: String,
}

#[derive(Deserialize)]
struct SessionReadRequest {
    key: String,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct SessionInputRequest {
    key: String,
    data: Option<String>,
    keys: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct SessionResizeRequest {
    key: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionKillPrefixRequest {
    key_prefix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitForRequest {
    key: String,
    pattern: String,
    flags: Option<String>,
    timeout_ms: Option<u64>,
    scope: Option<String>,
    follow_replacement: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitAnyRequest {
    targets: Vec<WaitTarget>,
    timeout_ms: Option<u64>,
    quorum: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitTarget {
    key: String,
    label: Option<String>,
    pattern: Option<String>,
    flags: Option<String>,
    scope: Option<String>,
    idle_ms: Option<u64>,
}

struct LiveWaitTarget {
    target: WaitTarget,
    matcher: Option<PatternMatcher>,
    last_seq: u64,
    last_changed_at: Instant,
}

struct ReadyWaitMatch {
    payload: serde_json::Value,
    order_ms: u64,
}

struct FlowControl {
    state: StdMutex<FlowControlState>,
    ready: Condvar,
}

struct FlowControlState {
    paused_clients: usize,
}

struct ClientFlow {
    outstanding: AtomicUsize,
    paused: AtomicBool,
}

struct PatternMatcher {
    regex: Regex,
    sticky: bool,
}

#[derive(Deserialize, Serialize)]
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
    let sessions_dir = state_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).context("failed to create kiriterm sessions dir")?;
    let _lock = DaemonLock::acquire(state_dir.join("daemon.lock"))?;
    let token = token();
    let shutdown = CancellationToken::new();
    let restored_sessions = load_persisted_sessions(&sessions_dir);
    let state = AppState {
        token: token.clone(),
        record_path: state_dir.join("daemon.json"),
        sessions_dir,
        idle_kill_ms: idle_kill_ms(),
        shutdown: shutdown.clone(),
        sessions: Arc::new(RwLock::new(HashMap::new())),
        generations: Arc::new(RwLock::new(HashMap::new())),
        launch_configs: Arc::new(RwLock::new(HashMap::new())),
        pending_inputs: Arc::new(RwLock::new(HashMap::new())),
        restored_sessions: Arc::new(Mutex::new(restored_sessions)),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/agents/upsert", post(upsert_agent))
        .route("/api/agents/spawn", post(spawn_agent))
        .route("/api/agents/close-runtime", post(close_agent_runtime))
        .route("/api/agents/input", post(input_agent))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/read", post(read_session))
        .route("/api/sessions/snapshot", post(snapshot_session))
        .route("/api/sessions/input", post(input_session))
        .route("/api/sessions/resize", post(resize_session))
        .route("/api/sessions/wait-for", post(wait_for_session))
        .route("/api/sessions/wait-any", post(wait_any_session))
        .route("/api/sessions/kill", post(kill_session))
        .route("/api/sessions/kill-prefix", post(kill_prefix))
        .route("/api/shutdown", post(shutdown_daemon))
        .route(DAEMON_PATH, get(terminal_ws))
        .with_state(state.clone());
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("failed to bind kiri-termd")?;
    let port = listener.local_addr()?.port();
    write_record(&state.record_path, &token, port)?;
    axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_shutdown(shutdown.clone()))
        .await
        .context("kiri-termd server failed")?;
    persist_all_sessions(&state).await;
    close_all_sessions(&state).await;
    remove_owned_record(&state.record_path);
    Ok(())
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
    let agent_id = body.config.id.clone();
    state
        .launch_configs
        .write()
        .await
        .insert(agent_id.clone(), body.config);
    if !body.pending_inputs.is_empty() {
        let mut pending_inputs = state.pending_inputs.write().await;
        pending_inputs
            .entry(agent_id)
            .or_default()
            .extend(body.pending_inputs);
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn spawn_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SpawnAgentRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(config) = state
        .launch_configs
        .read()
        .await
        .get(&body.agent_id)
        .cloned()
    else {
        return not_found(format!(
            "No launch config registered for agent {}",
            body.agent_id
        ));
    };
    match spawn_runtime_session(
        &state,
        config,
        body.cols.unwrap_or(80),
        body.rows.unwrap_or(24),
    )
    .await
    {
        Ok(_) => Json(serde_json::json!({ "ok": true, "codexLaunches": [] })).into_response(),
        Err(error) => server_error(error.to_string()),
    }
}

async fn close_agent_runtime(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentIdRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let key = format!("{}:runtime", body.agent_id);
    if let Some(session) = session_by_key(&state, &key).await {
        kill_session_process(&state, &session).await;
    }
    state.restored_sessions.lock().await.remove(&key);
    let _ = fs::remove_file(persisted_session_path(&state.sessions_dir, &key));
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn input_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AgentInputRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    if body.text.is_empty() {
        return bad_request("text is required".to_string());
    }
    let key = format!("{}:runtime", body.agent_id);
    if let Some(session) = session_by_key(&state, &key).await {
        if !session.exited.load(Ordering::SeqCst) {
            let data = if body.submit {
                format!("{}\r", body.text)
            } else {
                body.text
            };
            if let Err(error) = write_session_input(&session, &data).await {
                return server_error(error.to_string());
            }
            return Json(serde_json::json!({ "ok": true, "delivered": true })).into_response();
        }
    }
    if !state
        .launch_configs
        .read()
        .await
        .contains_key(&body.agent_id)
    {
        return not_found(format!("Unknown agent {}", body.agent_id));
    }
    state
        .pending_inputs
        .write()
        .await
        .entry(body.agent_id)
        .or_default()
        .push(PendingInput {
            text: body.text,
            submit: body.submit,
            created_at: iso_now(),
        });
    Json(serde_json::json!({ "ok": true, "delivered": false, "queued": true })).into_response()
}

async fn list_sessions(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let sessions = state.sessions.read().await;
    let mut payload = Vec::with_capacity(sessions.len());
    for session in sessions.values() {
        let cols = *session.cols.lock().await;
        let rows = *session.rows.lock().await;
        payload.push(serde_json::json!({
            "key": session.key,
            "mode": session.mode,
            "label": session.label,
            "cwd": session.cwd,
            "generation": session.generation.load(Ordering::SeqCst),
            "cols": cols,
            "rows": rows,
            "attachedClients": session.attached_clients.load(Ordering::SeqCst),
            "exited": session.exited.load(Ordering::SeqCst),
        }));
    }
    Json(serde_json::json!({ "sessions": payload })).into_response()
}

async fn read_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionReadRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(session) = session_by_key(&state, &body.key).await else {
        return not_found(format!("No session {}", body.key));
    };
    let screen = {
        let grid = session.grid.lock().await;
        let screen = grid.read_screen();
        let buffer_type = grid.buffer_type();
        serde_json::json!({
            "lines": screen.lines,
            "cursorX": screen.cursor_x,
            "cursorY": screen.cursor_y,
            "cols": screen.cols,
            "rows": screen.rows,
            "bufferType": buffer_type,
        })
    };
    let generation = session.generation.load(Ordering::SeqCst);
    Json(serde_json::json!({
        "screen": screen,
        "generation": generation,
        "cursor": cursor_for(&session),
        "output": output_since(&session, body.cursor.as_deref()).await,
    }))
    .into_response()
}

async fn snapshot_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionKeyRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(session) = session_by_key(&state, &body.key).await else {
        return not_found(format!("No session {}", body.key));
    };
    let snapshot = session.grid.lock().await.serialize_ansi();
    Json(serde_json::json!({
        "snapshot": snapshot,
        "generation": session.generation.load(Ordering::SeqCst),
    }))
    .into_response()
}

async fn input_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionInputRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(session) = session_by_key(&state, &body.key).await else {
        return not_found(format!("No live session {}", body.key));
    };
    if session.exited.load(Ordering::SeqCst) {
        return not_found(format!("No live session {}", body.key));
    }
    let mut data = body.data.unwrap_or_default();
    if let Some(keys) = body.keys {
        match encode_terminal_keys(&keys) {
            Ok(encoded) => data.push_str(&encoded),
            Err(error) => return bad_request(error),
        }
    }
    if !data.is_empty() {
        if let Err(error) = write_session_input(&session, &data).await {
            return server_error(error.to_string());
        }
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn resize_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionResizeRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(session) = session_by_key(&state, &body.key).await else {
        return not_found(format!("No live session {}", body.key));
    };
    if session.exited.load(Ordering::SeqCst) {
        return not_found(format!("No live session {}", body.key));
    }
    if let Err(error) = resize_session_to(&session, body.cols, body.rows).await {
        return server_error(error.to_string());
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn wait_for_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WaitForRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let Some(session) = session_by_key(&state, &body.key).await else {
        return not_found(format!("No session {}", body.key));
    };
    let matcher = match compile_regex(&body.pattern, body.flags.as_deref().unwrap_or("")) {
        Ok(matcher) => matcher,
        Err(error) => return bad_request(error),
    };
    let scope = body.scope.as_deref().unwrap_or("screen");
    if !matches!(scope, "screen" | "output") {
        return bad_request(format!("Invalid wait scope: {scope}"));
    }
    let started_at = Instant::now();
    let timeout = wait_timeout(body.timeout_ms, 30_000);
    let follow_replacement = body.follow_replacement.unwrap_or(true);
    while started_at.elapsed() < timeout {
        let target = if follow_replacement {
            match session_by_key(&state, &body.key).await {
                Some(session) => session,
                None => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
            }
        } else {
            session.clone()
        };
        if let Some(found) = match_session_target(&target, &matcher, scope).await {
            return Json(serde_json::json!({
                "matched": true,
                "match": found,
                "generation": session_by_key(&state, &body.key).await
                    .map(|session| session.generation.load(Ordering::SeqCst))
                    .unwrap_or_else(|| target.generation.load(Ordering::SeqCst)),
                "elapsedMs": started_at.elapsed().as_millis() as u64,
            }))
            .into_response();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Json(serde_json::json!({
        "matched": false,
        "elapsedMs": started_at.elapsed().as_millis() as u64,
    }))
    .into_response()
}

async fn wait_any_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WaitAnyRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    if body.targets.is_empty() || body.targets.len() > 32 {
        return bad_request("targets must contain 1..32 entries".to_string());
    }
    let quorum = body.quorum.as_deref().unwrap_or("any");
    if !matches!(quorum, "any" | "all") {
        return bad_request(format!("Invalid quorum: {quorum}"));
    }
    let started_at = Instant::now();
    let timeout = wait_timeout(body.timeout_ms, 60_000);
    let mut missing = Vec::new();
    let mut live = Vec::new();

    for target in body.targets {
        if target.pattern.is_none() && target.idle_ms.is_none() {
            return bad_request("Each target needs pattern and/or idleMs".to_string());
        }
        let Some(session) = session_by_key(&state, &target.key).await else {
            missing.push(target.key);
            continue;
        };
        if session.exited.load(Ordering::SeqCst) {
            missing.push(target.key);
            continue;
        }
        let matcher = match &target.pattern {
            Some(pattern) => match compile_regex(pattern, target.flags.as_deref().unwrap_or("")) {
                Ok(matcher) => Some(matcher),
                Err(error) => return bad_request(error),
            },
            None => None,
        };
        let last_seq = session.output_seq.load(Ordering::SeqCst);
        live.push(LiveWaitTarget {
            target,
            matcher,
            last_seq,
            last_changed_at: Instant::now(),
        });
    }

    if live.is_empty() {
        return wait_any_response(false, Vec::new(), missing, started_at);
    }

    let mut matches = Vec::new();
    let mut matched = vec![false; live.len()];
    while started_at.elapsed() < timeout {
        let mut ready_any: Vec<ReadyWaitMatch> = Vec::new();
        for (index, live_target) in live.iter_mut().enumerate() {
            if matched[index] {
                continue;
            }
            let Some(session) = session_by_key(&state, &live_target.target.key).await else {
                continue;
            };
            if session.exited.load(Ordering::SeqCst) {
                if live_target.target.idle_ms.is_some() {
                    matched[index] = true;
                    let payload =
                        wait_match_payload(&live_target.target, &session, None, true).await;
                    if quorum == "any" {
                        return wait_any_response(true, vec![payload], missing, started_at);
                    }
                    matches.push(payload);
                }
                continue;
            }
            if let Some(matcher) = &live_target.matcher {
                let scope = live_target.target.scope.as_deref().unwrap_or("screen");
                if !matches!(scope, "screen" | "output") {
                    return bad_request(format!("Invalid wait scope: {scope}"));
                }
                if let Some(found) = match_session_target(&session, matcher, scope).await {
                    matched[index] = true;
                    let payload =
                        wait_match_payload(&live_target.target, &session, Some(found), false).await;
                    if quorum == "any" {
                        ready_any.push(ReadyWaitMatch {
                            payload,
                            order_ms: session.last_output_at_ms.load(Ordering::SeqCst),
                        });
                        continue;
                    }
                    matches.push(payload);
                    continue;
                }
            }
            if let Some(idle_ms) = live_target.target.idle_ms {
                if !(250..=600_000).contains(&idle_ms) {
                    return bad_request("idleMs must be between 250 and 600000".to_string());
                }
                let seq = session.output_seq.load(Ordering::SeqCst);
                if seq != live_target.last_seq {
                    live_target.last_seq = seq;
                    live_target.last_changed_at = Instant::now();
                }
                if live_target.last_changed_at.elapsed() >= Duration::from_millis(idle_ms) {
                    matched[index] = true;
                    let payload =
                        wait_match_payload(&live_target.target, &session, None, true).await;
                    if quorum == "any" {
                        ready_any.push(ReadyWaitMatch {
                            payload,
                            order_ms: live_target
                                .last_changed_at
                                .duration_since(started_at)
                                .as_millis() as u64,
                        });
                        continue;
                    }
                    matches.push(payload);
                }
            }
        }
        if quorum == "any" && !ready_any.is_empty() {
            ready_any.sort_by_key(|ready| ready.order_ms);
            let winner = ready_any.remove(0).payload;
            return wait_any_response(true, vec![winner], missing, started_at);
        }
        if quorum == "all" && matches.len() == live.len() {
            return wait_any_response(missing.is_empty(), matches, missing, started_at);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    wait_any_response(false, matches, missing, started_at)
}

async fn kill_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionKeyRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    if let Some(session) = session_by_key(&state, &body.key).await {
        kill_session_process(&state, &session).await;
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn kill_prefix(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionKillPrefixRequest>,
) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    let sessions = state.sessions.read().await;
    let targets: Vec<_> = sessions
        .values()
        .filter(|session| {
            session.key == body.key_prefix
                || session.key.starts_with(&format!("{}:", body.key_prefix))
        })
        .cloned()
        .collect();
    drop(sessions);
    for session in &targets {
        kill_session_process(&state, session).await;
    }
    Json(serde_json::json!({ "ok": true, "killed": targets.len() })).into_response()
}

async fn shutdown_daemon(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(response) = unauthorized_response(&state, &headers) {
        return response;
    }
    state.shutdown.cancel();
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
    let (cols, rows, snapshot, snapshot_seq, generation) = {
        let grid = session.grid.lock().await;
        let cols = grid.cols() as u16;
        let rows = grid.rows() as u16;
        let snapshot = grid.serialize_ansi();
        let snapshot_seq = session.output_seq.load(Ordering::SeqCst);
        let generation = session.generation.load(Ordering::SeqCst);
        (cols, rows, snapshot, snapshot_seq, generation)
    };
    let (mut sender, mut receiver) = socket.split();
    if sender
        .send(Message::Text(frame_text(&ServerFrame::Snapshot {
            data: snapshot,
            cols,
            rows,
            generation,
        })))
        .await
        .is_err()
    {
        return;
    }
    session.idle_epoch.fetch_add(1, Ordering::SeqCst);
    session.attached_clients.fetch_add(1, Ordering::SeqCst);
    let client_flow = Arc::new(ClientFlow::new());
    session
        .flow_control
        .register_client(&session.client_flows, Arc::downgrade(&client_flow));

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
                if write_session_input(&session, &data).await.is_err() {
                    break;
                }
            }
            ClientFrame::Resize { cols, rows } => {
                if let Err(error) = resize_session_to(&session, cols, rows).await {
                    warn!("failed to resize pty for {}: {error}", session.key);
                }
            }
            ClientFrame::Ack { bytes } => {
                session
                    .flow_control
                    .ack_from_client(&client_flow, bytes as usize);
            }
        }
    }
    output_task.abort();
    session.flow_control.release_client(&client_flow);
    if session.attached_clients.fetch_sub(1, Ordering::SeqCst) == 1 {
        schedule_idle_kill(state, session.clone());
    }
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
    if query.mode == "runtime" {
        let Some(config) = config else {
            anyhow::bail!("No launch config registered for agent {}", query.agent_id);
        };
        return spawn_runtime_session(
            state,
            config,
            query.cols.unwrap_or(80),
            query.rows.unwrap_or(24),
        )
        .await;
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
    let generation = next_generation(state, &key).await;
    let restored = state.restored_sessions.lock().await.remove(&key);
    let launch = SessionLaunch::shell(
        key.clone(),
        cwd,
        query.cols.unwrap_or(80),
        query.rows.unwrap_or(24),
    );
    let (session, reader) = spawn_pty_session(launch, generation, restored)?;
    let session = Arc::new(session);
    start_reader(session.clone(), reader);
    sessions.insert(key, session.clone());
    Ok(session)
}

async fn spawn_runtime_session(
    state: &AppState,
    config: LaunchConfig,
    cols: u16,
    rows: u16,
) -> Result<Arc<Session>> {
    let key = format!("{}:runtime", config.id);
    if let Some(session) = session_by_key(state, &key).await {
        if !session.exited.load(Ordering::SeqCst) {
            drain_pending_inputs(state, &config.id, &session).await;
            return Ok(session);
        }
    }
    let mut sessions = state.sessions.write().await;
    if let Some(session) = sessions.get(&key).cloned() {
        if !session.exited.load(Ordering::SeqCst) {
            drop(sessions);
            drain_pending_inputs(state, &config.id, &session).await;
            return Ok(session);
        }
        sessions.remove(&key);
    }
    let generation = next_generation(state, &key).await;
    let restored = state.restored_sessions.lock().await.remove(&key);
    let mut pending = {
        state
            .pending_inputs
            .write()
            .await
            .remove(&config.id)
            .unwrap_or_default()
    };
    let launch = match SessionLaunch::runtime(config.clone(), key.clone(), cols, rows) {
        Ok(launch) => launch,
        Err(error) => {
            if !pending.is_empty() {
                state
                    .pending_inputs
                    .write()
                    .await
                    .entry(config.id)
                    .or_default()
                    .splice(0..0, pending);
            }
            return Err(error);
        }
    };
    let (session, reader) = match spawn_pty_session(launch, generation, restored) {
        Ok(spawned) => spawned,
        Err(error) => {
            if !pending.is_empty() {
                state
                    .pending_inputs
                    .write()
                    .await
                    .entry(config.id)
                    .or_default()
                    .splice(0..0, pending);
            }
            return Err(error);
        }
    };
    let session = Arc::new(session);
    start_reader(session.clone(), reader);
    sessions.insert(key, session.clone());
    drop(sessions);
    for input in pending.drain(..) {
        if let Err(error) = write_session_input(&session, &pending_input_data(&input)).await {
            warn!("failed to drain pending input for {}: {error}", config.id);
        }
    }
    Ok(session)
}

async fn drain_pending_inputs(state: &AppState, agent_id: &str, session: &Session) {
    let mut pending = state
        .pending_inputs
        .write()
        .await
        .remove(agent_id)
        .unwrap_or_default();
    for input in pending.drain(..) {
        if let Err(error) = write_session_input(session, &pending_input_data(&input)).await {
            warn!("failed to drain pending input for {agent_id}: {error}");
        }
    }
}

struct SessionLaunch {
    key: String,
    mode: String,
    label: String,
    cwd: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

impl SessionLaunch {
    fn shell(key: String, cwd: String, cols: u16, rows: u16) -> Self {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut env = common_terminal_env();
        env.insert("KIRI_PROJECT_CWD".to_string(), cwd.clone());
        Self {
            key,
            mode: "shell".to_string(),
            label: "shell".to_string(),
            cwd,
            command: shell,
            args: Vec::new(),
            env,
            cols,
            rows,
        }
    }

    fn runtime(config: LaunchConfig, key: String, cols: u16, rows: u16) -> Result<Self> {
        let runtime = config.runtime.as_str();
        let env = runtime_env(&config);
        let mut args = Vec::new();
        let runtime_state = parse_runtime_state(config.runtime_state_json.as_deref());
        let command = match runtime {
            "codex" => {
                let resume = runtime_state.get("resume");
                if resume.is_some() {
                    args.push("resume".to_string());
                }
                args.extend([
                    "--dangerously-bypass-approvals-and-sandbox".to_string(),
                    "--no-alt-screen".to_string(),
                ]);
                if !config.model.is_empty() {
                    args.extend(["--model".to_string(), config.model.clone()]);
                }
                if let Some(resume) = resume {
                    args.push(resume.clone());
                }
                env::var("KIRI_CODEX_BIN")
                    .ok()
                    .or_else(|| runtime_state.get("binaryPath").cloned())
                    .unwrap_or_else(|| "codex".to_string())
            }
            "claude" => {
                args.extend([
                    "--dangerously-skip-permissions".to_string(),
                    "--append-system-prompt".to_string(),
                    format!("Kiri terminal session {}", config.id),
                ]);
                if !config.model.is_empty() {
                    args.extend(["--model".to_string(), config.model.clone()]);
                }
                if let Some(resume) = runtime_state.get("resume") {
                    args.extend(["--resume".to_string(), resume.clone()]);
                }
                env::var("KIRI_CLAUDE_BIN")
                    .ok()
                    .or_else(|| runtime_state.get("binaryPath").cloned())
                    .unwrap_or_else(|| "claude".to_string())
            }
            "pi" => {
                args.extend(["--session-dir".to_string(), config.session_dir.clone()]);
                if let Some(session_file) = &config.session_file {
                    args.extend(["--session".to_string(), session_file.clone()]);
                }
                if !config.model.is_empty() {
                    args.extend(["--model".to_string(), config.model.clone()]);
                }
                env::var("KIRI_PI_BIN").unwrap_or_else(|_| "pi".to_string())
            }
            "opencode" => {
                args.push(config.cwd.clone());
                if !config.model.is_empty() {
                    args.extend(["--model".to_string(), config.model.clone()]);
                }
                if let Some(resume) = runtime_state
                    .get("resume")
                    .or_else(|| runtime_state.get("opencodeSessionId"))
                {
                    args.extend(["--session".to_string(), resume.clone()]);
                }
                env::var("KIRI_OPENCODE_BIN")
                    .ok()
                    .or_else(|| runtime_state.get("binaryPath").cloned())
                    .unwrap_or_else(|| "opencode".to_string())
            }
            _ => anyhow::bail!("Unsupported terminal runtime: {runtime}"),
        };
        Ok(Self {
            key,
            mode: "runtime".to_string(),
            label: runtime.to_string(),
            cwd: config.cwd,
            command,
            args,
            env,
            cols,
            rows,
        })
    }
}

fn spawn_pty_session(
    launch: SessionLaunch,
    generation: u64,
    restored: Option<PersistedSession>,
) -> Result<(Session, Box<dyn Read + Send>)> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: launch.rows,
            cols: launch.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to open pty")?;
    let mut command = CommandBuilder::new(launch.command);
    command.args(launch.args);
    command.cwd(&launch.cwd);
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    command.env_remove("NO_COLOR");
    command.env_remove("NODE_DISABLE_COLORS");
    let child = pair
        .slave
        .spawn_command(command)
        .context("failed to spawn terminal process")?;
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
    let mut grid = Grid::new(usize::from(launch.cols), usize::from(launch.rows));
    if let Some(restored) = restored {
        grid.feed(restored.snapshot.as_bytes());
        grid.feed(b"\r\n\x1b[2m[kiriterm: restored scrollback from previous session]\x1b[0m\r\n");
    }
    Ok((
        Session {
            key: launch.key,
            mode: launch.mode,
            label: launch.label,
            cwd: launch.cwd,
            cols: Mutex::new(launch.cols),
            rows: Mutex::new(launch.rows),
            grid: Mutex::new(grid),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            exited: AtomicBool::new(false),
            generation: AtomicU64::new(generation),
            output_seq: AtomicU64::new(0),
            last_output_at_ms: AtomicU64::new(epoch_ms() as u64),
            recent_output: Mutex::new(Vec::new()),
            attached_clients: AtomicUsize::new(0),
            idle_epoch: AtomicU64::new(0),
            flow_control: FlowControl::new(),
            client_flows: StdMutex::new(Vec::new()),
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
            session.flow_control.wait_until_ready(&session.exited);
            if session.exited.load(Ordering::SeqCst) {
                break;
            }
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
                            session
                                .last_output_at_ms
                                .store(epoch_ms() as u64, Ordering::SeqCst);
                            session.output_seq.fetch_add(1, Ordering::SeqCst) + 1
                        };
                        if !text.is_empty() {
                            session
                                .flow_control
                                .reserve_for_clients(&session.client_flows, text.len());
                            push_recent_output(&session, seq, text.clone()).await;
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

async fn session_by_key(state: &AppState, key: &str) -> Option<Arc<Session>> {
    state.sessions.read().await.get(key).cloned()
}

async fn write_session_input(session: &Session, data: &str) -> Result<()> {
    let mut writer = session.writer.lock().await;
    writer
        .write_all(data.as_bytes())
        .context("failed to write terminal input")?;
    writer.flush().context("failed to flush terminal input")
}

async fn resize_session_to(session: &Session, cols: u16, rows: u16) -> Result<()> {
    *session.cols.lock().await = cols;
    *session.rows.lock().await = rows;
    session
        .grid
        .lock()
        .await
        .resize(usize::from(cols), usize::from(rows));
    session
        .master
        .lock()
        .await
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("failed to resize pty")
}

async fn kill_session_process(state: &AppState, session: &Session) {
    session.exited.store(true, Ordering::SeqCst);
    session.idle_epoch.fetch_add(1, Ordering::SeqCst);
    session.flow_control.wake();
    let _ = session.child.lock().await.kill();
    let _ = session.tx.send(SessionEvent::Exit {
        message: "terminal process exited".to_string(),
    });
    remove_session_from_registry(state, &session.key).await;
}

fn schedule_idle_kill(state: AppState, session: Arc<Session>) {
    if session.mode != "shell" || session.exited.load(Ordering::SeqCst) {
        return;
    }
    let epoch = session.idle_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(state.idle_kill_ms)).await;
        if session.idle_epoch.load(Ordering::SeqCst) != epoch
            || session.attached_clients.load(Ordering::SeqCst) != 0
            || session.exited.load(Ordering::SeqCst)
        {
            return;
        }
        kill_session_process(&state, &session).await;
    });
}

async fn close_all_sessions(state: &AppState) {
    let sessions: Vec<_> = state.sessions.read().await.values().cloned().collect();
    for session in sessions {
        session.exited.store(true, Ordering::SeqCst);
        session.idle_epoch.fetch_add(1, Ordering::SeqCst);
        session.flow_control.wake();
        let _ = session.child.lock().await.kill();
        let _ = session.tx.send(SessionEvent::Exit {
            message: "terminal process exited".to_string(),
        });
    }
    state.sessions.write().await.clear();
}

async fn remove_session_from_registry(state: &AppState, key: &str) {
    state.sessions.write().await.remove(key);
}

fn load_persisted_sessions(sessions_dir: &Path) -> HashMap<String, PersistedSession> {
    let mut restored = HashMap::new();
    let Ok(entries) = fs::read_dir(sessions_dir) else {
        return restored;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<PersistedSession>(&contents) else {
            continue;
        };
        restored.insert(session.key.clone(), session);
    }
    restored
}

async fn persist_all_sessions(state: &AppState) {
    let sessions: Vec<_> = state.sessions.read().await.values().cloned().collect();
    for session in sessions {
        if let Err(error) = persist_session(state, &session).await {
            warn!("failed to persist session {}: {error}", session.key);
        }
    }
}

async fn persist_session(state: &AppState, session: &Session) -> Result<()> {
    let (cols, rows, snapshot) = {
        let grid = session.grid.lock().await;
        (
            grid.cols() as u16,
            grid.rows() as u16,
            grid.serialize_ansi(),
        )
    };
    let persisted = PersistedSession {
        key: session.key.clone(),
        mode: session.mode.clone(),
        label: session.label.clone(),
        cwd: session.cwd.clone(),
        cols,
        rows,
        snapshot,
        saved_at: iso_now(),
    };
    let path = persisted_session_path(&state.sessions_dir, &session.key);
    write_file_atomic(&path, &serde_json::to_vec_pretty(&persisted)?)
        .with_context(|| format!("failed to persist {}", session.key))
}

fn persisted_session_path(sessions_dir: &Path, key: &str) -> PathBuf {
    sessions_dir.join(format!("{}.json", encode_uri_component(key)))
}

fn runtime_env(config: &LaunchConfig) -> HashMap<String, String> {
    let mut env = common_terminal_env();
    env.insert("KIRI_AGENT_ID".to_string(), config.id.clone());
    env.insert("KIRI_PROJECT_CWD".to_string(), config.cwd.clone());
    env.insert("KIRI_RUNTIME".to_string(), config.runtime.clone());
    env.insert("KIRI_MODEL".to_string(), config.model.clone());
    env.insert("KIRI_SESSION_DIR".to_string(), config.session_dir.clone());
    if let Some(session_file) = &config.session_file {
        env.insert("KIRI_SESSION_FILE".to_string(), session_file.clone());
    }
    env
}

fn common_terminal_env() -> HashMap<String, String> {
    HashMap::from([
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("FORCE_COLOR".to_string(), "3".to_string()),
        ("CLICOLOR".to_string(), "1".to_string()),
        ("CLICOLOR_FORCE".to_string(), "1".to_string()),
    ])
}

fn pending_input_data(input: &PendingInput) -> String {
    if input.submit {
        format!("{}\r", input.text)
    } else {
        input.text.clone()
    }
}

fn parse_runtime_state(value: Option<&str>) -> HashMap<String, String> {
    let Some(value) = value else {
        return HashMap::new();
    };
    let Ok(serde_json::Value::Object(object)) = serde_json::from_str::<serde_json::Value>(value)
    else {
        return HashMap::new();
    };
    object
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key, value.to_string())))
        .collect()
}

fn write_file_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("failed to create atomic write parent")?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("session.json");
    let temp_path =
        path.with_file_name(format!(".{file_name}.{}.{}.tmp", process::id(), epoch_ms()));
    fs::write(&temp_path, contents).context("failed to write temp file")?;
    fs::rename(&temp_path, path).context("failed to rename temp file")
}

fn encode_uri_component(input: &str) -> String {
    input
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

async fn next_generation(state: &AppState, key: &str) -> u64 {
    let mut generations = state.generations.write().await;
    let generation = generations.entry(key.to_string()).or_insert(0);
    let current = *generation;
    *generation = generation.saturating_add(1);
    current
}

async fn push_recent_output(session: &Session, seq: u64, data: String) {
    let mut output = session.recent_output.lock().await;
    output.push(OutputChunk { seq, data });
    trim_recent_output(&mut output);
}

fn trim_recent_output(output: &mut Vec<OutputChunk>) {
    let mut total: usize = output.iter().map(|chunk| chunk.data.len()).sum();
    while output.len() > 1 && total > MAX_RECENT_OUTPUT_BYTES {
        let removed = output.remove(0);
        total = total.saturating_sub(removed.data.len());
    }
}

async fn output_since(session: &Session, cursor: Option<&str>) -> String {
    let Some(cursor) = cursor else {
        return String::new();
    };
    let generation = session.generation.load(Ordering::SeqCst);
    let after_seq = match parse_cursor(cursor) {
        Some((cursor_generation, seq)) if cursor_generation == generation => Some(seq),
        _ => None,
    };
    session
        .recent_output
        .lock()
        .await
        .iter()
        .filter(|chunk| after_seq.map_or(true, |seq| chunk.seq > seq))
        .map(|chunk| chunk.data.as_str())
        .collect()
}

async fn match_session_target(
    session: &Session,
    matcher: &PatternMatcher,
    scope: &str,
) -> Option<String> {
    if session.exited.load(Ordering::SeqCst) {
        return None;
    }
    let target = if scope == "screen" {
        session.grid.lock().await.read_screen().lines.join("\n")
    } else {
        recent_output_text(session).await
    };
    matcher.regex.find(&target).and_then(|found| {
        if matcher.sticky && found.start() != 0 {
            None
        } else {
            Some(found.as_str().to_string())
        }
    })
}

async fn recent_output_text(session: &Session) -> String {
    session
        .recent_output
        .lock()
        .await
        .iter()
        .map(|chunk| chunk.data.as_str())
        .collect()
}

async fn wait_match_payload(
    target: &WaitTarget,
    session: &Session,
    found: Option<String>,
    idle: bool,
) -> serde_json::Value {
    let tail = read_screen_tail(session).await;
    let mut payload = serde_json::json!({
        "key": target.key,
        "tail": tail,
    });
    if let Some(label) = &target.label {
        payload["label"] = serde_json::json!(label);
    }
    if let Some(found) = found {
        payload["match"] = serde_json::json!(found);
    }
    if idle {
        payload["idle"] = serde_json::json!(true);
    }
    payload
}

async fn read_screen_tail(session: &Session) -> Vec<String> {
    session
        .grid
        .lock()
        .await
        .read_screen()
        .lines
        .into_iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn wait_any_response(
    matched: bool,
    matches: Vec<serde_json::Value>,
    missing: Vec<String>,
    started_at: Instant,
) -> axum::response::Response {
    Json(serde_json::json!({
        "matched": matched,
        "matches": matches,
        "missing": missing,
        "elapsedMs": started_at.elapsed().as_millis() as u64,
    }))
    .into_response()
}

fn compile_regex(pattern: &str, flags: &str) -> std::result::Result<PatternMatcher, String> {
    if !flags
        .chars()
        .all(|flag| matches!(flag, 'g' | 'i' | 'm' | 's' | 'u' | 'y'))
    {
        return Err(format!("Invalid regex flags: {flags}"));
    }
    let regex = RegexBuilder::new(pattern)
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'))
        .build()
        .map_err(|error| error.to_string())?;
    Ok(PatternMatcher {
        regex,
        sticky: flags.contains('y'),
    })
}

fn wait_timeout(timeout_ms: Option<u64>, default_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(default_ms).clamp(1, 600_000))
}

fn cursor_for(session: &Session) -> String {
    format!(
        "{}:{}",
        session.generation.load(Ordering::SeqCst),
        session.output_seq.load(Ordering::SeqCst)
    )
}

fn parse_cursor(cursor: &str) -> Option<(u64, u64)> {
    let (generation, seq) = cursor.split_once(':')?;
    Some((generation.parse().ok()?, seq.parse().ok()?))
}

fn encode_terminal_keys(keys: &[String]) -> std::result::Result<String, String> {
    keys.iter().map(|key| encode_terminal_key(key)).collect()
}

fn encode_terminal_key(key: &str) -> std::result::Result<String, String> {
    let normalized = key.trim().to_ascii_lowercase();
    let encoded = match normalized.as_str() {
        "enter" | "return" => "\r",
        "tab" => "\t",
        "escape" | "esc" => "\x1b",
        "backspace" => "\x7f",
        "space" => " ",
        "up" => "\x1b[A",
        "down" => "\x1b[B",
        "right" => "\x1b[C",
        "left" => "\x1b[D",
        "home" => "\x1b[H",
        "end" => "\x1b[F",
        "pageup" => "\x1b[5~",
        "pagedown" => "\x1b[6~",
        "insert" => "\x1b[2~",
        "delete" => "\x1b[3~",
        "f1" => "\x1bOP",
        "f2" => "\x1bOQ",
        "f3" => "\x1bOR",
        "f4" => "\x1bOS",
        "f5" => "\x1b[15~",
        "f6" => "\x1b[17~",
        "f7" => "\x1b[18~",
        "f8" => "\x1b[19~",
        "f9" => "\x1b[20~",
        "f10" => "\x1b[21~",
        "f11" => "\x1b[23~",
        "f12" => "\x1b[24~",
        _ => {
            if let Some(chord) = normalized
                .strip_prefix("c-")
                .or_else(|| normalized.strip_prefix("ctrl-"))
            {
                let mut chars = chord.chars();
                if let (Some(ch), None) = (chars.next(), chars.next()) {
                    if ch.is_ascii_lowercase() || matches!(ch, '[' | '\\' | ']' | '^' | '_') {
                        return Ok(((ch as u8 % 32) as char).to_string());
                    }
                }
            }
            return Err(format!("Unknown terminal key: {key:?}"));
        }
    };
    Ok(encoded.to_string())
}

fn unauthorized_response(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<axum::response::Response> {
    if authorized(
        &state.token,
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    ) {
        return None;
    }
    Some(
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Unauthorized" })),
        )
            .into_response(),
    )
}

fn not_found(message: String) -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn bad_request(message: String) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn server_error(message: String) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
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

fn idle_kill_ms() -> u64 {
    env::var("KIRI_TERM_IDLE_KILL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_IDLE_KILL_MS)
}

fn default_submit() -> bool {
    true
}

async fn wait_for_shutdown(shutdown: CancellationToken) {
    tokio::select! {
        _ = shutdown.cancelled() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

fn write_record(record_path: &PathBuf, token: &str, port: u16) -> Result<()> {
    let record = DaemonRecord {
        pid: process::id(),
        host: "127.0.0.1".to_string(),
        port,
        path: DAEMON_PATH.to_string(),
        token: token.to_string(),
        version: VERSION.to_string(),
        started_at: iso_now(),
    };
    fs::write(record_path, serde_json::to_vec_pretty(&record)?)
        .context("failed to write daemon record")
}

fn remove_owned_record(record_path: &PathBuf) {
    let Ok(contents) = fs::read_to_string(record_path) else {
        return;
    };
    let Ok(record) = serde_json::from_str::<DaemonRecord>(&contents) else {
        return;
    };
    if record.pid == process::id() {
        let _ = fs::remove_file(record_path);
    }
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

impl FlowControl {
    fn new() -> Self {
        Self {
            state: StdMutex::new(FlowControlState { paused_clients: 0 }),
            ready: Condvar::new(),
        }
    }

    fn wait_until_ready(&self, exited: &AtomicBool) {
        let mut state = self.state.lock().expect("flow-control mutex poisoned");
        while state.paused_clients > 0 && !exited.load(Ordering::SeqCst) {
            state = self.ready.wait(state).expect("flow-control mutex poisoned");
        }
    }

    fn register_client(&self, clients: &StdMutex<Vec<Weak<ClientFlow>>>, client: Weak<ClientFlow>) {
        clients
            .lock()
            .expect("client-flow registry mutex poisoned")
            .push(client);
    }

    fn reserve_for_clients(&self, clients: &StdMutex<Vec<Weak<ClientFlow>>>, bytes: usize) {
        let mut clients = clients.lock().expect("client-flow registry mutex poisoned");
        clients.retain(|client| {
            if let Some(client) = client.upgrade() {
                self.add_outstanding(&client, bytes);
                true
            } else {
                false
            }
        });
    }

    fn add_outstanding(&self, client: &ClientFlow, bytes: usize) {
        let outstanding = client.outstanding.fetch_add(bytes, Ordering::SeqCst) + bytes;
        if outstanding > FLOW_HIGH_WATERMARK_BYTES && !client.paused.swap(true, Ordering::SeqCst) {
            self.state
                .lock()
                .expect("flow-control mutex poisoned")
                .paused_clients += 1;
        }
    }

    fn ack_from_client(&self, client: &ClientFlow, bytes: usize) {
        let mut current = client.outstanding.load(Ordering::SeqCst);
        loop {
            let next = current.saturating_sub(bytes);
            match client.outstanding.compare_exchange(
                current,
                next,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    if next < FLOW_LOW_WATERMARK_BYTES
                        && client.paused.swap(false, Ordering::SeqCst)
                    {
                        self.resume_one_paused_client();
                    }
                    return;
                }
                Err(actual) => current = actual,
            }
        }
    }

    fn release_client(&self, client: &ClientFlow) {
        client.outstanding.store(0, Ordering::SeqCst);
        if client.paused.swap(false, Ordering::SeqCst) {
            self.resume_one_paused_client();
        }
    }

    fn resume_one_paused_client(&self) {
        {
            let mut state = self.state.lock().expect("flow-control mutex poisoned");
            state.paused_clients = state.paused_clients.saturating_sub(1);
        }
        self.ready.notify_all();
    }

    fn wake(&self) {
        self.ready.notify_all();
    }
}

impl ClientFlow {
    fn new() -> Self {
        Self {
            outstanding: AtomicUsize::new(0),
            paused: AtomicBool::new(false),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_output_trimming_keeps_latest_large_chunk() {
        let mut output = vec![
            OutputChunk {
                seq: 1,
                data: "old".to_string(),
            },
            OutputChunk {
                seq: 2,
                data: "x".repeat(MAX_RECENT_OUTPUT_BYTES + 1),
            },
        ];

        trim_recent_output(&mut output);

        assert_eq!(output.len(), 1);
        assert_eq!(output[0].seq, 2);
        assert_eq!(output[0].data.len(), MAX_RECENT_OUTPUT_BYTES + 1);
    }

    #[test]
    fn regex_sticky_flag_matches_only_at_start() {
        let matcher = compile_regex("needle", "y").unwrap();

        assert!(matcher.regex.find("xx needle").is_some());
        assert_eq!(
            matcher.regex.find("xx needle").and_then(|found| {
                if matcher.sticky && found.start() != 0 {
                    None
                } else {
                    Some(found.as_str())
                }
            }),
            None
        );
        assert_eq!(
            matcher.regex.find("needle xx").and_then(|found| {
                if matcher.sticky && found.start() != 0 {
                    None
                } else {
                    Some(found.as_str())
                }
            }),
            Some("needle")
        );
    }

    #[test]
    fn regex_rejects_unknown_flags() {
        assert!(compile_regex("needle", "z").is_err());
    }

    #[test]
    fn remove_owned_record_preserves_foreign_pid() {
        let dir = unique_test_dir("foreign-record");
        let record_path = dir.join("daemon.json");
        fs::write(
            &record_path,
            serde_json::json!({
                "pid": process::id() + 1,
                "host": "127.0.0.1",
                "port": 1234,
                "path": "/terminal",
                "token": "token",
                "version": "test",
                "startedAt": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .unwrap();

        remove_owned_record(&record_path);

        assert!(record_path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn remove_owned_record_deletes_current_pid() {
        let dir = unique_test_dir("owned-record");
        let record_path = dir.join("daemon.json");
        fs::write(
            &record_path,
            serde_json::json!({
                "pid": process::id(),
                "host": "127.0.0.1",
                "port": 1234,
                "path": "/terminal",
                "token": "token",
                "version": "test",
                "startedAt": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .unwrap();

        remove_owned_record(&record_path);

        assert!(!record_path.exists());
        let _ = fs::remove_dir_all(dir);
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("{name}-{}-{}", process::id(), epoch_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
