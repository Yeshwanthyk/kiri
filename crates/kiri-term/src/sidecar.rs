use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex, Weak};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

use crate::document::TerminalDocument;
use crate::protocol::{
    PasteBracketMode, TerminalId, TerminalInjectSource, TerminalServerFrame, TerminalSignal,
    TerminalStatus,
};
use crate::pty::PtyLaunch;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SidecarCommand {
    Create {
        terminal_id: TerminalId,
        launch: PtyLaunch,
    },
    Input {
        terminal_id: TerminalId,
        data: String,
    },
    Paste {
        terminal_id: TerminalId,
        text: String,
        submit: bool,
        bracketed: PasteBracketMode,
    },
    Inject {
        terminal_id: TerminalId,
        text: String,
        submit: bool,
        idempotency_key: String,
        source: TerminalInjectSource,
    },
    Resize {
        terminal_id: TerminalId,
        cols: u16,
        rows: u16,
    },
    Snapshot {
        terminal_id: TerminalId,
    },
    Signal {
        terminal_id: TerminalId,
        signal: TerminalSignal,
    },
    Kill {
        terminal_id: TerminalId,
    },
    Shutdown,
}

type SharedOutput = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedDocument = Arc<Mutex<TerminalDocument>>;
type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
type SharedOrder = Arc<Mutex<()>>;
type SharedSessions = Arc<Mutex<HashMap<TerminalId, Weak<Mutex<Box<dyn Child + Send + Sync>>>>>>;

const METRIC_FLUSH_INTERVAL: Duration = Duration::from_millis(250);

struct SidecarSession {
    terminal_id: TerminalId,
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    child: SharedChild,
    document: SharedDocument,
    order: SharedOrder,
    inject_keys: HashSet<String>,
}

pub fn run_stdio() -> Result<()> {
    run(io::stdin().lock(), Box::new(io::stdout()))
}

pub fn run<R: BufRead>(reader: R, output: Box<dyn Write + Send>) -> Result<()> {
    let output = Arc::new(Mutex::new(output));
    let shared_sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut sessions = HashMap::<TerminalId, SidecarSession>::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let command: SidecarCommand = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                write_frame(
                    &output,
                    &TerminalServerFrame::Error {
                        terminal_id: None,
                        message: format!("invalid command: {error}"),
                    },
                )?;
                continue;
            }
        };
        if matches!(command, SidecarCommand::Shutdown) {
            break;
        }
        let terminal_id = command_terminal_id(&command);
        if let Err(error) = handle_command(command, &mut sessions, &shared_sessions, &output) {
            if let Some(terminal_id) = terminal_id {
                fail_session(
                    &terminal_id,
                    &mut sessions,
                    &shared_sessions,
                    &output,
                    error,
                )?;
            } else {
                write_frame(
                    &output,
                    &TerminalServerFrame::Error {
                        terminal_id: None,
                        message: error.to_string(),
                    },
                )?;
            }
        }
    }

    for (_, session) in sessions {
        let _ = session.child.lock().map(|mut child| child.kill());
    }
    Ok(())
}

fn command_terminal_id(command: &SidecarCommand) -> Option<TerminalId> {
    match command {
        SidecarCommand::Create { terminal_id, .. }
        | SidecarCommand::Input { terminal_id, .. }
        | SidecarCommand::Paste { terminal_id, .. }
        | SidecarCommand::Inject { terminal_id, .. }
        | SidecarCommand::Resize { terminal_id, .. }
        | SidecarCommand::Snapshot { terminal_id }
        | SidecarCommand::Signal { terminal_id, .. }
        | SidecarCommand::Kill { terminal_id } => Some(terminal_id.clone()),
        SidecarCommand::Shutdown => None,
    }
}

fn fail_session(
    terminal_id: &TerminalId,
    sessions: &mut HashMap<TerminalId, SidecarSession>,
    shared_sessions: &SharedSessions,
    output: &SharedOutput,
    error: anyhow::Error,
) -> Result<()> {
    if let Some(session) = sessions.remove(terminal_id) {
        shared_sessions
            .lock()
            .expect("terminal sessions lock")
            .remove(terminal_id);
        let _ = session.child.lock().map(|mut child| child.kill());
    }
    write_frame(
        output,
        &TerminalServerFrame::Error {
            terminal_id: Some(terminal_id.clone()),
            message: error.to_string(),
        },
    )?;
    write_frame(
        output,
        &TerminalServerFrame::Status {
            terminal_id: terminal_id.clone(),
            status: TerminalStatus::Failed,
            pid: None,
            exit_code: Some(1),
        },
    )
}

fn handle_command(
    command: SidecarCommand,
    sessions: &mut HashMap<TerminalId, SidecarSession>,
    shared_sessions: &SharedSessions,
    output: &SharedOutput,
) -> Result<()> {
    match command {
        SidecarCommand::Create {
            terminal_id,
            launch,
        } => create_session(terminal_id, launch, sessions, shared_sessions, output),
        SidecarCommand::Input { terminal_id, data } => {
            with_session(&terminal_id, sessions, output, |session| {
                write_input(session, data.as_bytes())
            })
        }
        SidecarCommand::Paste {
            terminal_id,
            text,
            submit,
            bracketed,
        } => with_session(&terminal_id, sessions, output, |session| {
            let modes = session
                .document
                .lock()
                .expect("terminal document lock")
                .snapshot()
                .modes;
            let data = paste_payload(&text, submit, bracketed, modes.bracketed_paste);
            write_input(session, data.as_bytes())
        }),
        SidecarCommand::Inject {
            terminal_id,
            text,
            submit,
            idempotency_key,
            source: _,
        } => with_session(&terminal_id, sessions, output, |session| {
            if session.inject_keys.contains(&idempotency_key) {
                return Ok(());
            }
            let modes = session
                .document
                .lock()
                .expect("terminal document lock")
                .snapshot()
                .modes;
            let data = paste_payload(&text, submit, PasteBracketMode::Auto, modes.bracketed_paste);
            write_input(session, data.as_bytes())?;
            session.inject_keys.insert(idempotency_key);
            Ok(())
        }),
        SidecarCommand::Resize {
            terminal_id,
            cols,
            rows,
        } => with_session(&terminal_id, sessions, output, |session| {
            let _ordered = session.order.lock().expect("terminal order lock");
            session.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            let patch = session
                .document
                .lock()
                .expect("terminal document lock")
                .resize(usize::from(cols), usize::from(rows));
            write_frame(
                output,
                &TerminalServerFrame::Patch {
                    terminal_id: terminal_id.clone(),
                    patch,
                },
            )
        }),
        SidecarCommand::Snapshot { terminal_id } => {
            with_session(&terminal_id, sessions, output, |session| {
                let _ordered = session.order.lock().expect("terminal order lock");
                let snapshot = session
                    .document
                    .lock()
                    .expect("terminal document lock")
                    .snapshot();
                write_frame(
                    output,
                    &TerminalServerFrame::Snapshot {
                        terminal_id: terminal_id.clone(),
                        snapshot,
                    },
                )
            })
        }
        SidecarCommand::Signal {
            terminal_id,
            signal,
        } => with_session(&terminal_id, sessions, output, |session| match signal {
            TerminalSignal::Interrupt => write_input(session, b"\x03"),
            TerminalSignal::Eof => write_input(session, b"\x04"),
            TerminalSignal::Terminate | TerminalSignal::Kill => {
                session.child.lock().expect("terminal child lock").kill()?;
                Ok(())
            }
        }),
        SidecarCommand::Kill { terminal_id } => {
            if let Some(session) = sessions.remove(&terminal_id) {
                shared_sessions
                    .lock()
                    .expect("terminal sessions lock")
                    .remove(&terminal_id);
                session.child.lock().expect("terminal child lock").kill()?;
            }
            Ok(())
        }
        SidecarCommand::Shutdown => Ok(()),
    }
}

fn create_session(
    terminal_id: TerminalId,
    launch: PtyLaunch,
    sessions: &mut HashMap<TerminalId, SidecarSession>,
    shared_sessions: &SharedSessions,
    output: &SharedOutput,
) -> Result<()> {
    if sessions.contains_key(&terminal_id) {
        write_frame(
            output,
            &TerminalServerFrame::Error {
                terminal_id: Some(terminal_id),
                message: "terminal already exists".to_owned(),
            },
        )?;
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: launch.rows,
        cols: launch.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new(&launch.command);
    command.args(&launch.args);
    command.cwd(&launch.cwd);
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    let child = Arc::new(Mutex::new(pair.slave.spawn_command(command)?));
    let pid = child.lock().expect("terminal child lock").process_id();
    let mut reader = pair.master.try_clone_reader()?;
    let writer = Arc::new(Mutex::new(pair.master.take_writer()?));
    let document = Arc::new(Mutex::new(TerminalDocument::new(
        usize::from(launch.cols),
        usize::from(launch.rows),
    )));
    let order = Arc::new(Mutex::new(()));

    let session = SidecarSession {
        terminal_id: terminal_id.clone(),
        master: pair.master,
        writer,
        child,
        document: Arc::clone(&document),
        order: Arc::clone(&order),
        inject_keys: HashSet::new(),
    };
    shared_sessions
        .lock()
        .expect("terminal sessions lock")
        .insert(terminal_id.clone(), Arc::downgrade(&session.child));

    {
        let _ordered = order.lock().expect("terminal order lock");
        write_frame(
            output,
            &TerminalServerFrame::Status {
                terminal_id: terminal_id.clone(),
                status: TerminalStatus::Running,
                pid,
                exit_code: None,
            },
        )?;
        write_frame(
            output,
            &TerminalServerFrame::Snapshot {
                terminal_id: terminal_id.clone(),
                snapshot: session
                    .document
                    .lock()
                    .expect("terminal document lock")
                    .snapshot(),
            },
        )?;
        write_metric(
            output,
            &terminal_id,
            "terminal.cols",
            f64::from(launch.cols),
            "cells",
        )?;
        write_metric(
            output,
            &terminal_id,
            "terminal.rows",
            f64::from(launch.rows),
            "cells",
        )?;
    }
    spawn_reader(
        terminal_id.clone(),
        &mut reader,
        document,
        order,
        Arc::clone(shared_sessions),
        Arc::clone(output),
    );
    sessions.insert(terminal_id, session);
    Ok(())
}

fn spawn_reader(
    terminal_id: TerminalId,
    reader: &mut Box<dyn Read + Send>,
    document: SharedDocument,
    order: SharedOrder,
    sessions: SharedSessions,
    output: SharedOutput,
) {
    let mut reader = std::mem::replace(reader, Box::new(io::empty()));
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending_bytes: usize = 0;
        let mut pending_ops: usize = 0;
        let mut last_metric_flush = Instant::now();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = flush_reader_metrics(
                        &output,
                        &terminal_id,
                        &mut pending_bytes,
                        &mut pending_ops,
                    );
                    let exit_code = sessions
                        .lock()
                        .expect("terminal sessions lock")
                        .remove(&terminal_id)
                        .and_then(|child| child.upgrade())
                        .and_then(|child| {
                            child
                                .lock()
                                .expect("terminal child lock")
                                .try_wait()
                                .ok()
                                .flatten()
                        })
                        .map(|status| status.exit_code() as i32);
                    let _ = write_frame(
                        &output,
                        &TerminalServerFrame::Status {
                            terminal_id: terminal_id.clone(),
                            status: TerminalStatus::Exited,
                            pid: None,
                            exit_code,
                        },
                    );
                    break;
                }
                Ok(n) => {
                    let _ordered = order.lock().expect("terminal order lock");
                    let patch = document
                        .lock()
                        .expect("terminal document lock")
                        .apply_bytes(&buffer[..n]);
                    pending_bytes += n;
                    pending_ops += patch.ops.len();
                    let _ = write_frame(
                        &output,
                        &TerminalServerFrame::Patch {
                            terminal_id: terminal_id.clone(),
                            patch,
                        },
                    );
                    if last_metric_flush.elapsed() >= METRIC_FLUSH_INTERVAL {
                        let _ = flush_reader_metrics(
                            &output,
                            &terminal_id,
                            &mut pending_bytes,
                            &mut pending_ops,
                        );
                        last_metric_flush = Instant::now();
                    }
                }
                Err(error) => {
                    let _ = write_frame(
                        &output,
                        &TerminalServerFrame::Error {
                            terminal_id: Some(terminal_id.clone()),
                            message: error.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });
}

fn flush_reader_metrics(
    output: &SharedOutput,
    terminal_id: &TerminalId,
    pending_bytes: &mut usize,
    pending_ops: &mut usize,
) -> Result<()> {
    if *pending_bytes == 0 && *pending_ops == 0 {
        return Ok(());
    }
    if *pending_ops > 0 {
        write_metric(
            output,
            terminal_id,
            "terminal.patch.ops",
            *pending_ops as f64,
            "count",
        )?;
    }
    if *pending_bytes > 0 {
        write_metric(
            output,
            terminal_id,
            "terminal.pty.read_bytes",
            *pending_bytes as f64,
            "bytes",
        )?;
    }
    *pending_bytes = 0;
    *pending_ops = 0;
    Ok(())
}

fn with_session(
    terminal_id: &TerminalId,
    sessions: &mut HashMap<TerminalId, SidecarSession>,
    output: &SharedOutput,
    f: impl FnOnce(&mut SidecarSession) -> Result<()>,
) -> Result<()> {
    let Some(session) = sessions.get_mut(terminal_id) else {
        write_frame(
            output,
            &TerminalServerFrame::Error {
                terminal_id: Some(terminal_id.clone()),
                message: "unknown terminal".to_owned(),
            },
        )?;
        return Ok(());
    };
    f(session).with_context(|| format!("terminal {} command failed", session.terminal_id))
}

fn write_input(session: &mut SidecarSession, data: &[u8]) -> Result<()> {
    let mut writer = session.writer.lock().expect("terminal writer lock");
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

fn paste_payload(
    text: &str,
    submit: bool,
    bracketed: PasteBracketMode,
    bracketed_paste_enabled: bool,
) -> String {
    let mut data = String::new();
    let wrap = bracketed == PasteBracketMode::Force
        || (bracketed == PasteBracketMode::Auto && bracketed_paste_enabled);
    if wrap {
        data.push_str("\x1b[200~");
    }
    data.push_str(text);
    if wrap {
        data.push_str("\x1b[201~");
    }
    if submit {
        data.push('\r');
    }
    data
}

fn write_frame(output: &SharedOutput, frame: &TerminalServerFrame) -> Result<()> {
    let mut output = output.lock().expect("terminal output lock");
    serde_json::to_writer(&mut *output, frame)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn write_metric(
    output: &SharedOutput,
    terminal_id: &TerminalId,
    name: &str,
    value: f64,
    unit: &str,
) -> Result<()> {
    write_frame(
        output,
        &TerminalServerFrame::Metric {
            terminal_id: terminal_id.clone(),
            metric: crate::protocol::TerminalMetric {
                name: name.to_owned(),
                value,
                unit: unit.to_owned(),
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct SharedVecWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedVecWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().expect("output lock").extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn paste_payload_wraps_only_when_requested_or_enabled() {
        assert_eq!(
            paste_payload("hello", true, PasteBracketMode::Off, true),
            "hello\r",
        );
        assert_eq!(
            paste_payload("hello", false, PasteBracketMode::Auto, true),
            "\x1b[200~hello\x1b[201~",
        );
        assert_eq!(
            paste_payload("hello", true, PasteBracketMode::Force, false),
            "\x1b[200~hello\x1b[201~\r",
        );
    }

    #[test]
    fn sidecar_command_uses_camel_case_wire_shape() {
        let command = serde_json::to_string(&SidecarCommand::Paste {
            terminal_id: "term-1".to_owned(),
            text: "run".to_owned(),
            submit: true,
            bracketed: PasteBracketMode::Auto,
        })
        .expect("serialize command");

        assert!(command.contains("\"type\":\"paste\""));
        assert!(command.contains("\"terminalId\":\"term-1\""));
        assert!(command.contains("\"bracketed\":\"auto\""));
    }

    #[test]
    fn spawn_failure_reports_failed_terminal_and_keeps_serving() {
        let launch = PtyLaunch {
            command: "/definitely/not/kiri-term-test".to_owned(),
            args: vec![],
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };
        let input = format!(
            "{}\n{}\n",
            serde_json::to_string(&SidecarCommand::Create {
                terminal_id: "term-bad".to_owned(),
                launch,
            })
            .expect("serialize create"),
            serde_json::to_string(&SidecarCommand::Shutdown).expect("serialize shutdown"),
        );
        let output = Arc::new(Mutex::new(Vec::new()));

        run(
            Cursor::new(input),
            Box::new(SharedVecWriter(Arc::clone(&output))),
        )
        .expect("sidecar run");

        let output =
            String::from_utf8(output.lock().expect("output lock").clone()).expect("utf8 output");
        assert!(output.contains("\"type\":\"error\""));
        assert!(output.contains("\"terminalId\":\"term-bad\""));
        assert!(output.contains("\"status\":\"failed\""));
    }
}
