use serde::{Deserialize, Serialize};

use crate::cell::CellRun;
use crate::history::TerminalHistoryDelta;
use crate::protocol::{
    TerminalBufferKind, TerminalCursor, TerminalModes, TerminalRow, TerminalViewport,
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFramePatch {
    pub cols: usize,
    pub rows: usize,
    pub screen_seq: u64,
    pub history_seq: u64,
    pub history_delta: Option<TerminalHistoryDelta>,
    pub ops: Vec<TerminalPatchOp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TerminalPatchOp {
    ReplaceRow {
        row: TerminalRow,
    },
    ReplaceCells {
        row: usize,
        col: usize,
        runs: Vec<CellRun>,
    },
    InsertRows {
        row: usize,
        count: usize,
    },
    DeleteRows {
        row: usize,
        count: usize,
    },
    SetSize {
        cols: usize,
        rows: usize,
    },
    SetCursor {
        cursor: TerminalCursor,
    },
    SetModes {
        modes: TerminalModes,
    },
    SetBufferKind {
        buffer_kind: TerminalBufferKind,
    },
    SetViewport {
        viewport: TerminalViewport,
    },
    Reset,
}
