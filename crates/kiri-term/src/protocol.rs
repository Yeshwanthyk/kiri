use serde::{Deserialize, Serialize};

use crate::cell::CellRun;
use crate::patch::TerminalFramePatch;

pub type TerminalId = String;
pub type TerminalTabId = String;
pub type TerminalPaneId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalKind {
    Runtime,
    Shell,
    Workflow,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalBufferKind {
    #[default]
    Main,
    Alternate,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModes {
    pub bracketed_paste: bool,
    pub app_cursor_keys: bool,
    pub app_keypad: bool,
    pub mouse_basic: bool,
    pub mouse_sgr: bool,
    pub focus_reporting: bool,
    pub origin: bool,
    pub wrap: bool,
    pub synchronized_output: bool,
    pub cursor_visible: bool,
}

impl TerminalModes {
    pub fn new() -> Self {
        Self {
            cursor_visible: true,
            wrap: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCursor {
    pub row: usize,
    pub col: usize,
    pub visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRow {
    pub row: usize,
    pub runs: Vec<CellRun>,
    pub fingerprint: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub cols: usize,
    pub rows: usize,
    pub screen_seq: u64,
    pub history_seq: u64,
    pub buffer_kind: TerminalBufferKind,
    pub cursor: TerminalCursor,
    pub modes: TerminalModes,
    pub viewport: TerminalViewport,
    pub history_rows: Vec<TerminalHistoryRow>,
    pub rows_data: Vec<TerminalRow>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalViewport {
    pub history_offset: usize,
    pub visible_rows: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryRow {
    pub id: u64,
    pub row: TerminalRow,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalClientFrame {
    Attach {
        terminal_id: TerminalId,
        known_screen_seq: Option<u64>,
        known_history_seq: Option<u64>,
    },
    Input {
        terminal_id: TerminalId,
        bytes: Vec<u8>,
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
        cols: usize,
        rows: usize,
    },
    Signal {
        terminal_id: TerminalId,
        signal: TerminalSignal,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PasteBracketMode {
    Auto,
    Force,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalInjectSource {
    Workflow,
    KiriControl,
    Scratchpad,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalSignal {
    Interrupt,
    Eof,
    Terminate,
    Kill,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalServerFrame {
    Snapshot {
        terminal_id: TerminalId,
        snapshot: TerminalSnapshot,
    },
    Patch {
        terminal_id: TerminalId,
        patch: TerminalFramePatch,
    },
    HistoryDelta {
        terminal_id: TerminalId,
        delta: crate::history::TerminalHistoryDelta,
    },
    Status {
        terminal_id: TerminalId,
        status: TerminalStatus,
        pid: Option<u32>,
        exit_code: Option<i32>,
    },
    Error {
        terminal_id: Option<TerminalId>,
        message: String,
    },
}
