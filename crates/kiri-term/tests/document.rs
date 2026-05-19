use kiri_term::cell::TerminalColor;
use kiri_term::patch::{TerminalFramePatch, TerminalPatchOp};
use kiri_term::protocol::{
    TerminalBufferKind, TerminalCursor, TerminalHistoryRow, TerminalModes, TerminalRow,
    TerminalSnapshot, TerminalViewport,
};
use kiri_term::TerminalDocument;

#[test]
fn parses_plain_output_and_cursor() {
    let mut document = TerminalDocument::new(12, 3);
    let before = document.snapshot();
    let patch = document.apply_bytes(b"hello\nworld");
    assert_replay_matches(before, &patch, document.snapshot());

    assert_eq!(document.screen_text(), "hello\n     world\n");
    assert!(patch
        .ops
        .iter()
        .any(|op| matches!(op, TerminalPatchOp::ReplaceRow { row } if row.row == 0)));
    assert_eq!(document.snapshot().cursor.row, 1);
    assert_eq!(document.snapshot().cursor.col, 10);
}

#[test]
fn tracks_sgr_color_and_style_runs() {
    let mut document = TerminalDocument::new(12, 2);
    document.apply_bytes(b"\x1b[31;1mred\x1b[0m ok");
    let rows = document.snapshot().rows_data;

    assert_eq!(rows[0].runs[0].text, "red");
    assert!(rows[0].runs[0].style.bold);
    assert_eq!(
        rows[0].runs[0].style.foreground,
        Some(TerminalColor::Palette { index: 1 })
    );
    assert_eq!(rows[0].runs[1].text, " ok");
    assert!(!rows[0].runs[1].style.bold);
}

#[test]
fn handles_cursor_movement_and_erase_line() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes(b"abcdef\x1b[1;3HX\x1b[K");

    assert_eq!(document.screen_text(), "abX\n");
    assert_eq!(document.snapshot().cursor.row, 0);
    assert_eq!(document.snapshot().cursor.col, 3);
}

#[test]
fn supports_alt_screen_and_bracketed_paste_modes() {
    let mut document = TerminalDocument::new(8, 2);
    let before = document.snapshot();
    let patch = document.apply_bytes(b"main\x1b[?1049h\x1b[?2004halt");
    assert_replay_matches(before, &patch, document.snapshot());
    let snapshot = document.snapshot();

    assert_eq!(snapshot.buffer_kind, TerminalBufferKind::Alternate);
    assert!(snapshot.modes.bracketed_paste);
    assert_eq!(document.screen_text(), "alt\n");

    document.apply_bytes(b"\x1b[?1049l\x1b[?2004l");
    let snapshot = document.snapshot();
    assert_eq!(snapshot.buffer_kind, TerminalBufferKind::Main);
    assert!(!snapshot.modes.bracketed_paste);
    assert_eq!(document.screen_text(), "main\n");
    assert_eq!(snapshot.cursor.row, 0);
    assert_eq!(snapshot.cursor.col, 4);
}

#[test]
fn accounts_for_wide_characters() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes("a界b".as_bytes());
    let snapshot = document.snapshot();

    assert_eq!(snapshot.cursor.col, 4);
    assert_eq!(snapshot.rows_data[0].runs[0].text.trim_end(), "a界b");
    assert_eq!(snapshot.rows_data[0].runs[0].width, 4);
}

#[test]
fn clears_wide_fragments_when_overwritten_or_erased() {
    let mut document = TerminalDocument::new(8, 2);
    let before = document.snapshot();
    let patch = document.apply_bytes("界\u{8}X".as_bytes());
    assert_replay_matches(before, &patch, document.snapshot());
    let snapshot = document.snapshot();

    assert!(!snapshot.rows_data[0]
        .runs
        .iter()
        .any(|run| run.text.contains('界')));
    assert_eq!(snapshot.rows_data[0].runs[0].text, " X");

    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes("界\u{8}\x1b[K".as_bytes());
    assert_eq!(document.screen_text(), "\n");
}

#[test]
fn resize_clears_truncated_wide_cells() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes("界".as_bytes());
    let before = document.snapshot();
    let patch = document.resize(1, 2);
    let snapshot = document.snapshot();

    assert_replay_matches(before, &patch, snapshot.clone());
    assert!(snapshot.rows_data[0].runs.is_empty());
}

#[test]
fn attaches_combining_marks_to_wide_lead_cells() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes("界\u{0301}".as_bytes());
    let snapshot = document.snapshot();

    assert_eq!(snapshot.rows_data[0].runs[0].text, "界\u{301}");
    assert_eq!(snapshot.rows_data[0].runs[0].width, 2);
}

#[test]
fn emits_history_delta_and_snapshot_history_rows() {
    let mut document = TerminalDocument::new(4, 2);
    let snapshot = document.snapshot();
    let patch = document.apply_bytes(b"a\nb\nc");
    let replayed = ReplayState::from_snapshot(snapshot).apply_patch(&patch);
    assert_eq!(replayed.to_snapshot(), document.snapshot());

    assert_eq!(patch.history_seq, 1);
    assert_eq!(
        patch
            .history_delta
            .as_ref()
            .expect("history delta")
            .rows
            .len(),
        1
    );
    assert_eq!(document.snapshot().history_rows.len(), 1);
    assert_eq!(replayed.history_rows.len(), 1);
    assert_eq!(replayed.rows_data[0].runs[0].text, " b");
    assert_eq!(replayed.rows_data[1].runs[0].text, "  c");
}

#[test]
fn resize_patch_is_authoritative_for_replay() {
    let mut document = TerminalDocument::new(4, 2);
    let snapshot = document.snapshot();
    let patch = document.resize(10, 4);
    let replayed = ReplayState::from_snapshot(snapshot).apply_patch(&patch);
    assert_eq!(replayed.to_snapshot(), document.snapshot());

    assert_eq!(patch.cols, 10);
    assert_eq!(patch.rows, 4);
    assert!(patch
        .ops
        .iter()
        .any(|op| matches!(op, TerminalPatchOp::SetSize { cols: 10, rows: 4 })));
    assert_eq!(replayed.cols, 10);
    assert_eq!(replayed.rows, 4);
    assert_eq!(replayed.rows_data.len(), 4);
}

#[derive(Debug)]
struct ReplayState {
    cols: usize,
    rows: usize,
    screen_seq: u64,
    history_seq: u64,
    buffer_kind: TerminalBufferKind,
    cursor: TerminalCursor,
    modes: TerminalModes,
    viewport: TerminalViewport,
    history_rows: Vec<TerminalHistoryRow>,
    rows_data: Vec<TerminalRow>,
}

impl ReplayState {
    fn from_snapshot(snapshot: TerminalSnapshot) -> Self {
        Self {
            cols: snapshot.cols,
            rows: snapshot.rows,
            screen_seq: snapshot.screen_seq,
            history_seq: snapshot.history_seq,
            buffer_kind: snapshot.buffer_kind,
            cursor: snapshot.cursor,
            modes: snapshot.modes,
            viewport: snapshot.viewport,
            history_rows: snapshot.history_rows,
            rows_data: snapshot.rows_data,
        }
    }

    fn apply_patch(mut self, patch: &TerminalFramePatch) -> Self {
        self.cols = patch.cols;
        self.rows = patch.rows;
        self.screen_seq = patch.screen_seq;
        self.history_seq = patch.history_seq;
        if let Some(delta) = &patch.history_delta {
            let trimmed = delta.trimmed.min(self.history_rows.len());
            self.history_rows.drain(0..trimmed);
            self.history_rows.extend(delta.rows.clone());
        }
        for op in &patch.ops {
            match op {
                TerminalPatchOp::ReplaceRow { row } => {
                    if row.row >= self.rows_data.len() {
                        self.rows_data.resize_with(row.row + 1, || TerminalRow {
                            row: 0,
                            runs: Vec::new(),
                            fingerprint: 0,
                        });
                    }
                    self.rows_data[row.row] = row.clone();
                }
                TerminalPatchOp::SetSize { cols, rows } => {
                    self.cols = *cols;
                    self.rows = *rows;
                    self.rows_data.resize_with(*rows, || TerminalRow {
                        row: 0,
                        runs: Vec::new(),
                        fingerprint: 0,
                    });
                    for (index, row) in self.rows_data.iter_mut().enumerate() {
                        row.row = index;
                    }
                }
                TerminalPatchOp::SetCursor { cursor } => {
                    self.cursor = cursor.clone();
                }
                TerminalPatchOp::SetModes { modes } => {
                    self.modes = modes.clone();
                }
                TerminalPatchOp::SetBufferKind { buffer_kind } => {
                    self.buffer_kind = buffer_kind.clone();
                }
                TerminalPatchOp::SetViewport { viewport } => {
                    self.viewport = viewport.clone();
                }
                TerminalPatchOp::Reset => {
                    self.rows_data.clear();
                    self.history_rows.clear();
                }
                _ => {}
            }
        }
        self
    }

    fn to_snapshot(&self) -> TerminalSnapshot {
        TerminalSnapshot {
            cols: self.cols,
            rows: self.rows,
            screen_seq: self.screen_seq,
            history_seq: self.history_seq,
            buffer_kind: self.buffer_kind.clone(),
            cursor: self.cursor.clone(),
            modes: self.modes.clone(),
            viewport: self.viewport.clone(),
            history_rows: self.history_rows.clone(),
            rows_data: self.rows_data.clone(),
        }
    }
}

fn assert_replay_matches(
    before: TerminalSnapshot,
    patch: &TerminalFramePatch,
    after: TerminalSnapshot,
) {
    assert_eq!(
        ReplayState::from_snapshot(before)
            .apply_patch(patch)
            .to_snapshot(),
        after
    );
}
