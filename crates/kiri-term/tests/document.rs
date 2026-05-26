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
fn preserves_blank_cells_between_styled_runs() {
    let mut document = TerminalDocument::new(12, 2);
    document.apply_bytes(b"\x1b[31mA\x1b[0m  \x1b[32mB");
    let row = &document.snapshot().rows_data[0];

    let rendered: String = row.runs.iter().map(|run| run.text.as_str()).collect();
    assert_eq!(rendered, "A  B");
    assert_eq!(row.runs[0].text, "A");
    assert_eq!(row.runs[1].text, "  ");
    assert_eq!(row.runs[2].text, "B");
}

#[test]
fn preserves_styled_blank_cells_after_erase_line() {
    let mut document = TerminalDocument::new(6, 2);
    document.apply_bytes(b"\x1b[48;5;235mX\x1b[K");
    let row = &document.snapshot().rows_data[0];

    let rendered: String = row.runs.iter().map(|run| run.text.as_str()).collect();
    assert_eq!(rendered, "X     ");
    assert_eq!(row.runs[0].width, 6);
    assert_eq!(
        row.runs[0].style.background,
        Some(TerminalColor::Palette { index: 235 })
    );
}

#[test]
fn erase_line_does_not_copy_underline_to_blank_cells() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes(b"\x1b[4mX\x1b[K");
    let row = &document.snapshot().rows_data[0];

    assert_eq!(row.runs[0].text, "X");
    assert!(row.runs[0].style.underline);
    assert!(row.runs.iter().skip(1).all(|run| !run.style.underline));
}

#[test]
fn erase_line_preserves_background_without_text_attributes() {
    let mut document = TerminalDocument::new(6, 2);
    document.apply_bytes(b"\x1b[4;48;5;235mX\x1b[K");
    let row = &document.snapshot().rows_data[0];

    assert_eq!(row.runs[0].text, "X");
    assert!(row.runs[0].style.underline);
    assert_eq!(
        row.runs[0].style.background,
        Some(TerminalColor::Palette { index: 235 })
    );
    assert_eq!(row.runs[1].text, "     ");
    assert!(!row.runs[1].style.underline);
    assert_eq!(
        row.runs[1].style.background,
        Some(TerminalColor::Palette { index: 235 })
    );
}

#[test]
fn erase_chars_do_not_copy_underline_to_blank_cells() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes(b"\x1b[4mABCDEFGH\x1b[1;3H\x1b[3X");
    let row = &document.snapshot().rows_data[0];

    assert_eq!(row.runs[0].text, "AB");
    assert!(row.runs[0].style.underline);
    assert_eq!(row.runs[1].text, "   ");
    assert!(!row.runs[1].style.underline);
    assert_eq!(row.runs[2].text, "FGH");
    assert!(row.runs[2].style.underline);
}

#[test]
fn sgr_colon_subparams_do_not_leak_underline() {
    let mut document = TerminalDocument::new(16, 2);
    document.apply_bytes(b"\x1b[4:1munder\x1b[4:0m plain");
    let rows = document.snapshot().rows_data;

    assert_eq!(rows[0].runs[0].text, "under");
    assert!(rows[0].runs[0].style.underline);
    assert_eq!(rows[0].runs[1].text, " plain");
    assert!(!rows[0].runs[1].style.underline);
}

#[test]
fn sgr_colon_extended_colors_match_semicolon_form() {
    let mut document = TerminalDocument::new(16, 2);
    document.apply_bytes(b"\x1b[38:5:196;48:5:21mred\x1b[0m \x1b[48:2:1:2:3mcell");
    let rows = document.snapshot().rows_data;

    assert_eq!(
        rows[0].runs[0].style.foreground,
        Some(TerminalColor::Palette { index: 196 })
    );
    assert_eq!(
        rows[0].runs[0].style.background,
        Some(TerminalColor::Palette { index: 21 })
    );
    assert_eq!(
        rows[0].runs[2].style.background,
        Some(TerminalColor::Rgb { r: 1, g: 2, b: 3 })
    );
}

#[test]
fn sgr_colon_truecolor_skips_optional_color_space_subparam() {
    let mut document = TerminalDocument::new(16, 2);
    document.apply_bytes(b"\x1b[38:2::1:2:3mfg\x1b[0m");
    let rows = document.snapshot().rows_data;

    assert_eq!(
        rows[0].runs[0].style.foreground,
        Some(TerminalColor::Rgb { r: 1, g: 2, b: 3 })
    );
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
fn supports_xterm_cursor_aliases_and_repeat_printable() {
    let mut document = TerminalDocument::new(16, 5);
    document.apply_bytes(b"abc\x1b[3b");
    assert_eq!(document.screen_text(), "abcccc\n\n\n\n");
    assert_eq!(document.snapshot().cursor.col, 6);

    let mut document = TerminalDocument::new(16, 5);
    document.apply_bytes(b"x\x1b[10`Y");
    assert_eq!(document.screen_text(), "x        Y\n\n\n\n");
    assert_eq!(document.snapshot().cursor.col, 10);

    let mut document = TerminalDocument::new(16, 5);
    document.apply_bytes(b"x\x1b[10aY");
    assert_eq!(document.screen_text(), "x          Y\n\n\n\n");
    assert_eq!(document.snapshot().cursor.col, 12);

    let mut document = TerminalDocument::new(16, 5);
    document.apply_bytes(b"x\x1b[3eY");
    assert_eq!(document.screen_text(), "x\n\n\n Y\n");
    assert_eq!(document.snapshot().cursor.row, 3);
    assert_eq!(document.snapshot().cursor.col, 2);
}

#[test]
fn supports_tab_controls_used_by_terminal_apps() {
    let mut document = TerminalDocument::new(24, 2);
    document.apply_bytes(b"x\x1b[2IY");
    assert_eq!(document.screen_text(), "x               Y\n");
    assert_eq!(document.snapshot().cursor.col, 17);

    let mut document = TerminalDocument::new(24, 2);
    document.apply_bytes(b"\x1b[5G\x1bH\x1b[1G\x1b[IY");
    assert_eq!(document.screen_text(), "    Y\n");
    assert_eq!(document.snapshot().cursor.col, 5);

    let mut document = TerminalDocument::new(24, 2);
    document.apply_bytes(b"\x1b[9G\x1b[g\x1b[1G\x1b[IY");
    assert_eq!(document.screen_text(), "                Y\n");
    assert_eq!(document.snapshot().cursor.col, 17);
}

#[test]
fn queues_device_query_responses_for_pty_writeback() {
    let mut document = TerminalDocument::new(24, 5);
    document.apply_bytes(b"\x1b[3;4H\x1b[6n\x1b[c\x1b[>c\x1b[5n");

    assert_eq!(
        String::from_utf8(document.take_pending_responses()).unwrap(),
        "\x1b[3;4R\x1b[?62;4;c\x1b[>0;0;0c\x1b[0n",
    );
    assert!(document.take_pending_responses().is_empty());
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

#[test]
fn scroll_region_keeps_tui_header_and_footer_stable() {
    let mut document = TerminalDocument::new(8, 4);
    let before = document.snapshot();
    let patch = document
        .apply_bytes(b"\x1b[1;1HHEAD\x1b[2;1HBODY1\x1b[3;1HBODY2\x1b[4;1HFOOT\x1b[2;3r\x1b[3;1H\n");
    assert_replay_matches(before, &patch, document.snapshot());

    assert_eq!(document.screen_text(), "HEAD\nBODY2\n\nFOOT");
    assert_eq!(document.snapshot().history_rows.len(), 0);
}

#[test]
fn reverse_index_scrolls_down_inside_scroll_region() {
    let mut document = TerminalDocument::new(8, 4);
    document
        .apply_bytes(b"\x1b[1;1HHEAD\x1b[2;1Hone\x1b[3;1Htwo\x1b[4;1HFOOT\x1b[2;3r\x1b[2;1H\x1bM");

    assert_eq!(document.screen_text(), "HEAD\n\none\nFOOT");
}

#[test]
fn insert_and_delete_lines_are_limited_to_scroll_region() {
    let mut document = TerminalDocument::new(8, 5);
    document.apply_bytes(b"\x1b[1;1HHEAD\x1b[2;1Hone\x1b[3;1Htwo\x1b[4;1Hthree\x1b[5;1HFOOT");
    document.apply_bytes(b"\x1b[2;4r\x1b[3;1H\x1b[L");
    assert_eq!(document.screen_text(), "HEAD\none\n\ntwo\nFOOT");

    document.apply_bytes(b"\x1b[3;1H\x1b[M");
    assert_eq!(document.screen_text(), "HEAD\none\ntwo\n\nFOOT");
}

#[test]
fn explicit_screen_edits_do_not_push_scrollback_history() {
    let mut document = TerminalDocument::new(8, 3);
    document.apply_bytes(b"\x1b[1;1Hone\x1b[2;1Htwo\x1b[3;1Hthree\x1b[1;1H\x1b[M");
    assert_eq!(document.screen_text(), "two\nthree\n");
    assert_eq!(document.snapshot().history_rows.len(), 0);

    document.apply_bytes(b"\x1b[1;1H\x1b[2S");
    assert_eq!(document.snapshot().history_rows.len(), 0);
}

#[test]
fn insert_delete_and_erase_chars_support_prompt_redraws() {
    let mut document = TerminalDocument::new(8, 2);
    document.apply_bytes(b"abcdef\x1b[1;3H\x1b[2P");
    assert_eq!(document.screen_text(), "abef\n");

    document.apply_bytes(b"\x1b[1;3H\x1b[2@XY");
    assert_eq!(document.screen_text(), "abXYef\n");

    document.apply_bytes(b"\x1b[1;3H\x1b[2X");
    assert_eq!(document.screen_text(), "ab  ef\n");
}

#[test]
fn origin_mode_positions_cursor_relative_to_scroll_region() {
    let mut document = TerminalDocument::new(6, 5);
    document.apply_bytes(b"\x1b[2;4r\x1b[?6h\x1b[1;1HX");

    assert_eq!(document.screen_text(), "\nX\n\n\n");
    assert_eq!(document.snapshot().cursor.row, 1);
    assert_eq!(document.snapshot().cursor.col, 1);
}

#[test]
fn cursor_save_restore_keeps_style_and_origin_mode_per_screen() {
    let mut document = TerminalDocument::new(8, 5);
    document.apply_bytes(
        b"\x1b[2;4r\x1b[?6h\x1b[31m\x1b[2;2H\x1b7\x1b[?6l\x1b[?7l\x1b[0m\x1b[1;1H\x1b8X",
    );
    let snapshot = document.snapshot();

    assert!(snapshot.modes.origin);
    assert!(snapshot.modes.wrap);
    assert_eq!(snapshot.cursor.row, 2);
    assert_eq!(snapshot.cursor.col, 2);
    assert_eq!(snapshot.rows_data[2].runs[1].text, "X");
    assert_eq!(
        snapshot.rows_data[2].runs[1].style.foreground,
        Some(TerminalColor::Palette { index: 1 })
    );

    document.apply_bytes(b"\x1b[?1049h\x1b[5;5H\x1b7\x1b[1;1H\x1b8Y");
    let snapshot = document.snapshot();
    assert_eq!(snapshot.cursor.row, 4);
    assert_eq!(snapshot.cursor.col, 5);
    assert_eq!(snapshot.rows_data[4].runs[0].text, "    ");
    assert_eq!(snapshot.rows_data[4].runs[1].text, "Y");
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
