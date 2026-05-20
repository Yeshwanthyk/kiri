use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use unicode_width::UnicodeWidthChar;
use vte::{Params, Parser, Perform};

use crate::cell::{Cell, CellRun, CellStyle, TerminalColor};
use crate::history::{HistoryRing, TerminalHistoryDelta};
use crate::patch::{TerminalFramePatch, TerminalPatchOp};
use crate::protocol::{
    TerminalBufferKind, TerminalCursor, TerminalModes, TerminalRow, TerminalSnapshot,
    TerminalViewport,
};

const DEFAULT_HISTORY_ROWS: usize = 10_000;

#[derive(Clone, Debug)]
struct ScreenBuffer {
    cells: Vec<Vec<Cell>>,
}

#[derive(Clone, Debug)]
struct SavedCursor {
    row: usize,
    col: usize,
    style: CellStyle,
    origin: bool,
    wrap: bool,
}

impl Default for SavedCursor {
    fn default() -> Self {
        Self {
            row: 0,
            col: 0,
            style: CellStyle::default(),
            origin: false,
            wrap: true,
        }
    }
}

impl ScreenBuffer {
    fn new(cols: usize, rows: usize) -> Self {
        Self {
            cells: vec![blank_row(cols, CellStyle::default()); rows],
        }
    }

    fn resize(&mut self, cols: usize, rows: usize, style: CellStyle) {
        self.cells
            .resize_with(rows, || blank_row(cols, style.clone()));
        for row in &mut self.cells {
            row.resize_with(cols, || Cell::blank(style.clone()));
            normalize_wide_cells(row, style.clone());
        }
    }
}

pub struct TerminalDocument {
    cols: usize,
    rows: usize,
    cursor_row: usize,
    cursor_col: usize,
    main_cursor_row: usize,
    main_cursor_col: usize,
    main_saved_cursor: SavedCursor,
    alternate_saved_cursor: SavedCursor,
    scroll_top: usize,
    scroll_bottom: usize,
    style: CellStyle,
    modes: TerminalModes,
    buffer_kind: TerminalBufferKind,
    main: ScreenBuffer,
    alternate: ScreenBuffer,
    history: HistoryRing,
    pending_history_delta: Option<TerminalHistoryDelta>,
    parser: Parser,
    screen_seq: u64,
    last_rows: Vec<u64>,
}

impl TerminalDocument {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let mut document = Self {
            cols,
            rows,
            cursor_row: 0,
            cursor_col: 0,
            main_cursor_row: 0,
            main_cursor_col: 0,
            main_saved_cursor: SavedCursor::default(),
            alternate_saved_cursor: SavedCursor::default(),
            scroll_top: 0,
            scroll_bottom: rows - 1,
            style: CellStyle::default(),
            modes: TerminalModes::new(),
            buffer_kind: TerminalBufferKind::Main,
            main: ScreenBuffer::new(cols, rows),
            alternate: ScreenBuffer::new(cols, rows),
            history: HistoryRing::new(DEFAULT_HISTORY_ROWS),
            pending_history_delta: None,
            parser: Parser::new(),
            screen_seq: 0,
            last_rows: Vec::new(),
        };
        document.last_rows = document.row_fingerprints();
        document
    }

    pub fn apply_bytes(&mut self, bytes: &[u8]) -> TerminalFramePatch {
        let before = self.last_rows.clone();
        let mut parser = std::mem::take(&mut self.parser);
        parser.advance(self, bytes);
        self.parser = parser;
        self.emit_patch(before)
    }

    pub fn resize(&mut self, cols: usize, rows: usize) -> TerminalFramePatch {
        let before = self.last_rows.clone();
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        let erase_style = self.erase_style();
        self.main.resize(self.cols, self.rows, erase_style.clone());
        self.alternate.resize(self.cols, self.rows, erase_style);
        self.cursor_row = self.cursor_row.min(self.rows - 1);
        self.cursor_col = self.cursor_col.min(self.cols - 1);
        self.main_saved_cursor.row = self.main_saved_cursor.row.min(self.rows - 1);
        self.main_saved_cursor.col = self.main_saved_cursor.col.min(self.cols - 1);
        self.alternate_saved_cursor.row = self.alternate_saved_cursor.row.min(self.rows - 1);
        self.alternate_saved_cursor.col = self.alternate_saved_cursor.col.min(self.cols - 1);
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.emit_patch(before)
    }

    pub fn snapshot(&self) -> TerminalSnapshot {
        TerminalSnapshot {
            cols: self.cols,
            rows: self.rows,
            screen_seq: self.screen_seq,
            history_seq: self.history.seq(),
            buffer_kind: self.buffer_kind.clone(),
            cursor: self.cursor(),
            modes: self.modes.clone(),
            viewport: self.viewport(),
            history_rows: self.history.rows(),
            rows_data: self.rows_data(),
        }
    }

    pub fn screen_text(&self) -> String {
        self.active()
            .cells
            .iter()
            .map(|row| {
                row.iter()
                    .filter(|cell| cell.width > 0)
                    .map(|cell| {
                        if cell.text.is_empty() {
                            " "
                        } else {
                            cell.text.as_str()
                        }
                    })
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn emit_patch(&mut self, before: Vec<u64>) -> TerminalFramePatch {
        let rows = self.rows_data();
        let mut ops = Vec::new();
        for row in &rows {
            if before.get(row.row).copied() != Some(row.fingerprint) {
                ops.push(TerminalPatchOp::ReplaceRow { row: row.clone() });
            }
        }
        ops.push(TerminalPatchOp::SetCursor {
            cursor: self.cursor(),
        });
        ops.push(TerminalPatchOp::SetModes {
            modes: self.modes.clone(),
        });
        ops.push(TerminalPatchOp::SetBufferKind {
            buffer_kind: self.buffer_kind.clone(),
        });
        ops.push(TerminalPatchOp::SetSize {
            cols: self.cols,
            rows: self.rows,
        });
        ops.push(TerminalPatchOp::SetViewport {
            viewport: self.viewport(),
        });
        let history_delta = self.pending_history_delta.take();
        self.screen_seq += 1;
        self.last_rows = rows.iter().map(|row| row.fingerprint).collect();
        TerminalFramePatch {
            cols: self.cols,
            rows: self.rows,
            screen_seq: self.screen_seq,
            history_seq: self.history.seq(),
            history_delta,
            ops,
        }
    }

    fn cursor(&self) -> TerminalCursor {
        TerminalCursor {
            row: self.cursor_row,
            col: self.cursor_col,
            visible: self.modes.cursor_visible,
        }
    }

    fn viewport(&self) -> TerminalViewport {
        TerminalViewport {
            history_offset: self.history.len(),
            visible_rows: self.rows,
        }
    }

    fn rows_data(&self) -> Vec<TerminalRow> {
        self.active()
            .cells
            .iter()
            .enumerate()
            .map(|(row, cells)| terminal_row(row, cells))
            .collect()
    }

    fn row_fingerprints(&self) -> Vec<u64> {
        self.active()
            .cells
            .iter()
            .map(|row| row_fingerprint(row))
            .collect()
    }

    fn active(&self) -> &ScreenBuffer {
        match self.buffer_kind {
            TerminalBufferKind::Main => &self.main,
            TerminalBufferKind::Alternate => &self.alternate,
        }
    }

    fn active_mut(&mut self) -> &mut ScreenBuffer {
        match self.buffer_kind {
            TerminalBufferKind::Main => &mut self.main,
            TerminalBufferKind::Alternate => &mut self.alternate,
        }
    }

    fn erase_style(&self) -> CellStyle {
        CellStyle {
            background: self.style.background.clone(),
            ..CellStyle::default()
        }
    }

    fn put_char(&mut self, c: char) {
        let width = UnicodeWidthChar::width(c).unwrap_or(1);
        if width == 0 {
            self.append_combining(c);
            return;
        }
        let should_wrap = self.modes.wrap
            && (self.cursor_col >= self.cols || (width == 2 && self.cursor_col + 1 >= self.cols));
        if should_wrap {
            self.newline();
            self.cursor_col = 0;
        }
        if self.cursor_col >= self.cols || (width == 2 && self.cursor_col + 1 >= self.cols) {
            return;
        }
        let row = self.cursor_row;
        let col = self.cursor_col;
        let cols = self.cols;
        let style = self.style.clone();
        self.clear_wide_fragment(row, col, style.clone());
        if width == 2 && col + 1 < cols {
            self.clear_wide_fragment(row, col + 1, style.clone());
        }
        let cells = &mut self.active_mut().cells[row];
        cells[col] = Cell::printable(c.to_string(), width as u8, style.clone());
        if width == 2 && col + 1 < cols {
            cells[col + 1] = Cell::continuation(style);
        }
        self.cursor_col = (self.cursor_col + width).min(self.cols);
    }

    fn append_combining(&mut self, c: char) {
        if self.cursor_col == 0 {
            return;
        }
        let row = self.cursor_row;
        let mut col = self.cursor_col - 1;
        let cells = &mut self.active_mut().cells[row];
        while col > 0 && cells[col].width == 0 {
            col -= 1;
        }
        if cells[col].width > 0 && !cells[col].text.is_empty() {
            cells[col].text.push(c);
        }
    }

    fn newline(&mut self) {
        if self.cursor_row == self.scroll_bottom {
            self.scroll_up_region(self.scroll_top, self.scroll_bottom, 1, true);
        } else {
            self.cursor_row = (self.cursor_row + 1).min(self.rows - 1);
        }
    }

    fn scroll_up_region(&mut self, top: usize, bottom: usize, count: usize, push_history: bool) {
        if top > bottom || bottom >= self.rows {
            return;
        }
        let style = self.erase_style();
        let cols = self.cols;
        let should_push_history = push_history
            && top == 0
            && bottom == self.rows - 1
            && self.buffer_kind == TerminalBufferKind::Main;
        let count = count.min(bottom - top + 1);
        for _ in 0..count {
            if should_push_history {
                let row = terminal_row(top, &self.active().cells[top]);
                let delta = self.history.push(row);
                self.push_history_delta(delta);
            }
            let active = self.active_mut();
            active.cells.remove(top);
            active.cells.insert(bottom, blank_row(cols, style.clone()));
        }
    }

    fn scroll_down_region(&mut self, top: usize, bottom: usize, count: usize) {
        if top > bottom || bottom >= self.rows {
            return;
        }
        let style = self.erase_style();
        let cols = self.cols;
        let count = count.min(bottom - top + 1);
        let active = self.active_mut();
        for _ in 0..count {
            active.cells.remove(bottom);
            active.cells.insert(top, blank_row(cols, style.clone()));
        }
    }

    fn carriage_return(&mut self) {
        self.cursor_col = 0;
    }

    fn backspace(&mut self) {
        self.cursor_col = self.cursor_col.saturating_sub(1);
    }

    fn tab(&mut self) {
        let next = ((self.cursor_col / 8) + 1) * 8;
        self.cursor_col = next.min(self.cols - 1);
    }

    fn clear_screen(&mut self) {
        let style = self.erase_style();
        let cols = self.cols;
        for row in &mut self.active_mut().cells {
            *row = blank_row(cols, style.clone());
        }
    }

    fn reset(&mut self) {
        let cols = self.cols;
        let rows = self.rows;
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.main_saved_cursor = SavedCursor::default();
        self.alternate_saved_cursor = SavedCursor::default();
        self.scroll_top = 0;
        self.scroll_bottom = rows - 1;
        self.style = CellStyle::default();
        self.modes = TerminalModes::new();
        self.buffer_kind = TerminalBufferKind::Main;
        self.main = ScreenBuffer::new(cols, rows);
        self.alternate = ScreenBuffer::new(cols, rows);
        self.pending_history_delta = None;
    }

    fn erase_display(&mut self, mode: u16) {
        match mode {
            0 => {
                self.erase_line_from_cursor();
                let cols = self.cols;
                let style = self.erase_style();
                let start = self.cursor_row + 1;
                for row in &mut self.active_mut().cells[start..] {
                    *row = blank_row(cols, style.clone());
                }
            }
            1 => {
                self.erase_line_to_cursor();
                let cols = self.cols;
                let style = self.erase_style();
                let cursor_row = self.cursor_row;
                for row in &mut self.active_mut().cells[..cursor_row] {
                    *row = blank_row(cols, style.clone());
                }
            }
            2 | 3 => self.clear_screen(),
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: u16) {
        match mode {
            0 => self.erase_line_from_cursor(),
            1 => self.erase_line_to_cursor(),
            2 => {
                let row = self.cursor_row;
                self.active_mut().cells[row] = blank_row(self.cols, self.erase_style());
            }
            _ => {}
        }
    }

    fn erase_line_from_cursor(&mut self) {
        let row = self.cursor_row;
        let col = self.cursor_col.min(self.cols - 1);
        let style = self.erase_style();
        self.clear_wide_fragment(row, col, style.clone());
        for cell in &mut self.active_mut().cells[row][col..] {
            *cell = Cell::blank(style.clone());
        }
    }

    fn erase_line_to_cursor(&mut self) {
        let row = self.cursor_row;
        let col = self.cursor_col.min(self.cols - 1);
        let style = self.erase_style();
        self.clear_wide_fragment(row, col, style.clone());
        for cell in &mut self.active_mut().cells[row][..=col] {
            *cell = Cell::blank(style.clone());
        }
    }

    fn cursor_up(&mut self, count: usize) {
        let min_row = if self.cursor_row >= self.scroll_top && self.cursor_row <= self.scroll_bottom
        {
            self.scroll_top
        } else {
            0
        };
        self.cursor_row = self.cursor_row.saturating_sub(count).max(min_row);
    }

    fn cursor_down(&mut self, count: usize) {
        let max_row = if self.cursor_row >= self.scroll_top && self.cursor_row <= self.scroll_bottom
        {
            self.scroll_bottom
        } else {
            self.rows - 1
        };
        self.cursor_row = (self.cursor_row + count).min(max_row);
    }

    fn cursor_forward(&mut self, count: usize) {
        self.cursor_col = (self.cursor_col + count).min(self.cols - 1);
    }

    fn cursor_back(&mut self, count: usize) {
        self.cursor_col = self.cursor_col.saturating_sub(count);
    }

    fn set_cursor_position(&mut self, row: usize, col: usize) {
        let row = row.saturating_sub(1);
        self.cursor_row = if self.modes.origin {
            (self.scroll_top + row).min(self.scroll_bottom)
        } else {
            row.min(self.rows - 1)
        };
        self.cursor_col = col.saturating_sub(1).min(self.cols - 1);
    }

    fn set_cursor_column(&mut self, col: usize) {
        self.cursor_col = col.saturating_sub(1).min(self.cols - 1);
    }

    fn set_cursor_row(&mut self, row: usize) {
        let row = row.saturating_sub(1);
        self.cursor_row = if self.modes.origin {
            (self.scroll_top + row).min(self.scroll_bottom)
        } else {
            row.min(self.rows - 1)
        };
    }

    fn next_line(&mut self, count: usize) {
        self.cursor_down(count);
        self.cursor_col = 0;
    }

    fn previous_line(&mut self, count: usize) {
        self.cursor_up(count);
        self.cursor_col = 0;
    }

    fn reverse_index(&mut self) {
        if self.cursor_row == self.scroll_top {
            self.scroll_down_region(self.scroll_top, self.scroll_bottom, 1);
        } else {
            self.cursor_up(1);
        }
    }

    fn save_cursor(&mut self) {
        let saved = SavedCursor {
            row: self.cursor_row,
            col: self.cursor_col,
            style: self.style.clone(),
            origin: self.modes.origin,
            wrap: self.modes.wrap,
        };
        match self.buffer_kind {
            TerminalBufferKind::Main => self.main_saved_cursor = saved,
            TerminalBufferKind::Alternate => self.alternate_saved_cursor = saved,
        }
    }

    fn restore_cursor(&mut self) {
        let saved = match self.buffer_kind {
            TerminalBufferKind::Main => self.main_saved_cursor.clone(),
            TerminalBufferKind::Alternate => self.alternate_saved_cursor.clone(),
        };
        self.cursor_row = saved.row.min(self.rows - 1);
        self.cursor_col = saved.col.min(self.cols - 1);
        self.style = saved.style;
        self.modes.origin = saved.origin;
        self.modes.wrap = saved.wrap;
    }

    fn set_scroll_region(&mut self, top: Option<u16>, bottom: Option<u16>) {
        let top = usize::from(top.filter(|value| *value > 0).unwrap_or(1)) - 1;
        let bottom = usize::from(
            bottom
                .filter(|value| *value > 0)
                .unwrap_or(self.rows.min(usize::from(u16::MAX)) as u16),
        ) - 1;
        if top < bottom && bottom < self.rows {
            self.scroll_top = top;
            self.scroll_bottom = bottom;
        } else {
            self.scroll_top = 0;
            self.scroll_bottom = self.rows - 1;
        }
        self.set_cursor_position(1, 1);
    }

    fn insert_lines(&mut self, count: usize) {
        if self.cursor_row < self.scroll_top || self.cursor_row > self.scroll_bottom {
            return;
        }
        self.scroll_down_region(self.cursor_row, self.scroll_bottom, count);
        self.cursor_col = 0;
    }

    fn delete_lines(&mut self, count: usize) {
        if self.cursor_row < self.scroll_top || self.cursor_row > self.scroll_bottom {
            return;
        }
        self.scroll_up_region(self.cursor_row, self.scroll_bottom, count, false);
        self.cursor_col = 0;
    }

    fn insert_chars(&mut self, count: usize) {
        let row = self.cursor_row;
        let col = self.cursor_col.min(self.cols - 1);
        let cols = self.cols;
        let count = count.min(cols - col);
        let style = self.erase_style();
        let cells = &mut self.active_mut().cells[row];
        for index in (col..cols - count).rev() {
            cells[index + count] = cells[index].clone();
        }
        for cell in &mut cells[col..col + count] {
            *cell = Cell::blank(style.clone());
        }
        normalize_wide_cells(cells, style);
    }

    fn delete_chars(&mut self, count: usize) {
        let row = self.cursor_row;
        let col = self.cursor_col.min(self.cols - 1);
        let cols = self.cols;
        let count = count.min(cols - col);
        let style = self.erase_style();
        let cells = &mut self.active_mut().cells[row];
        for index in col..cols - count {
            cells[index] = cells[index + count].clone();
        }
        for cell in &mut cells[cols - count..] {
            *cell = Cell::blank(style.clone());
        }
        normalize_wide_cells(cells, style);
    }

    fn erase_chars(&mut self, count: usize) {
        let row = self.cursor_row;
        let col = self.cursor_col.min(self.cols - 1);
        let count = count.min(self.cols - col);
        let style = self.erase_style();
        self.clear_wide_fragment(row, col, style.clone());
        for cell in &mut self.active_mut().cells[row][col..col + count] {
            *cell = Cell::blank(style.clone());
        }
    }

    fn clear_wide_fragment(&mut self, row: usize, col: usize, style: CellStyle) {
        if col >= self.cols {
            return;
        }
        let cells = &mut self.active_mut().cells[row];
        if cells[col].width == 0 && col > 0 {
            cells[col - 1] = Cell::blank(style.clone());
            cells[col] = Cell::blank(style);
            return;
        }
        if cells[col].width == 2 && col + 1 < cells.len() {
            cells[col] = Cell::blank(style.clone());
            cells[col + 1] = Cell::blank(style);
            return;
        }
        if col > 0 && cells[col - 1].width == 2 {
            cells[col - 1] = Cell::blank(style.clone());
            cells[col] = Cell::blank(style);
        }
    }

    fn push_history_delta(&mut self, delta: TerminalHistoryDelta) {
        match &mut self.pending_history_delta {
            Some(pending) => {
                pending.history_seq = delta.history_seq;
                pending.trimmed += delta.trimmed;
                pending.rows.extend(delta.rows);
            }
            None => self.pending_history_delta = Some(delta),
        }
    }

    fn set_private_mode(&mut self, mode: u16, enabled: bool) {
        match mode {
            1 => self.modes.app_cursor_keys = enabled,
            6 => {
                self.modes.origin = enabled;
                self.set_cursor_position(1, 1);
            }
            7 => self.modes.wrap = enabled,
            25 => self.modes.cursor_visible = enabled,
            1004 => self.modes.focus_reporting = enabled,
            1000 | 1002 => self.modes.mouse_basic = enabled,
            1006 => self.modes.mouse_sgr = enabled,
            1049 => {
                self.buffer_kind = if enabled {
                    self.main_cursor_row = self.cursor_row;
                    self.main_cursor_col = self.cursor_col;
                    self.cursor_row = 0;
                    self.cursor_col = 0;
                    self.scroll_top = 0;
                    self.scroll_bottom = self.rows - 1;
                    self.alternate = ScreenBuffer::new(self.cols, self.rows);
                    TerminalBufferKind::Alternate
                } else {
                    self.cursor_row = self.main_cursor_row.min(self.rows - 1);
                    self.cursor_col = self.main_cursor_col.min(self.cols - 1);
                    self.scroll_top = 0;
                    self.scroll_bottom = self.rows - 1;
                    TerminalBufferKind::Main
                };
            }
            2026 => self.modes.synchronized_output = enabled,
            2004 => self.modes.bracketed_paste = enabled,
            _ => {}
        }
    }

    fn apply_sgr(&mut self, params: &[SgrParam]) {
        if params.is_empty() {
            self.style = CellStyle::default();
            return;
        }
        let mut index = 0;
        while index < params.len() {
            let value = params[index].value();
            match value {
                0 => self.style = CellStyle::default(),
                1 => self.style.bold = true,
                2 => self.style.dim = true,
                3 => self.style.italic = true,
                4 => self.style.underline = params[index].subvalue().unwrap_or(1) != 0,
                7 => self.style.inverse = true,
                21 => self.style.underline = true,
                22 => {
                    self.style.bold = false;
                    self.style.dim = false;
                }
                23 => self.style.italic = false,
                24 => self.style.underline = false,
                27 => self.style.inverse = false,
                30..=37 => {
                    self.style.foreground = Some(TerminalColor::Palette {
                        index: (value - 30) as u8,
                    })
                }
                39 => self.style.foreground = None,
                40..=47 => {
                    self.style.background = Some(TerminalColor::Palette {
                        index: (value - 40) as u8,
                    })
                }
                49 => self.style.background = None,
                90..=97 => {
                    self.style.foreground = Some(TerminalColor::Palette {
                        index: (value - 90 + 8) as u8,
                    })
                }
                100..=107 => {
                    self.style.background = Some(TerminalColor::Palette {
                        index: (value - 100 + 8) as u8,
                    })
                }
                38 | 48 => {
                    if let Some((color, consumed)) = parse_extended_color(&params[index..]) {
                        if value == 38 {
                            self.style.foreground = Some(color);
                        } else {
                            self.style.background = Some(color);
                        }
                        index += consumed;
                    }
                }
                _ => {}
            }
            index += 1;
        }
    }
}

impl Perform for TerminalDocument {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' | 0x0b | 0x0c => self.newline(),
            b'\r' => self.carriage_return(),
            0x08 => self.backspace(),
            b'\t' => self.tab(),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        let values = flat_params(params);
        let first = values.first().copied().unwrap_or(0);
        match (intermediates, action) {
            (b"?", 'h') => {
                for mode in values {
                    self.set_private_mode(mode, true);
                }
            }
            (b"?", 'l') => {
                for mode in values {
                    self.set_private_mode(mode, false);
                }
            }
            (_, 'A') => self.cursor_up(count_param(first)),
            (_, 'B') => self.cursor_down(count_param(first)),
            (_, 'C') => self.cursor_forward(count_param(first)),
            (_, 'D') => self.cursor_back(count_param(first)),
            (_, 'E') => self.next_line(count_param(first)),
            (_, 'F') => self.previous_line(count_param(first)),
            (_, 'G') => self.set_cursor_column(values.first().copied().unwrap_or(1) as usize),
            (_, 'H' | 'f') => self.set_cursor_position(
                values.first().copied().unwrap_or(1) as usize,
                values.get(1).copied().unwrap_or(1) as usize,
            ),
            (_, 'J') => self.erase_display(first),
            (_, 'K') => self.erase_line(first),
            (_, 'L') => self.insert_lines(count_param(first)),
            (_, 'M') => self.delete_lines(count_param(first)),
            (_, 'P') => self.delete_chars(count_param(first)),
            (_, 'S') => self.scroll_up_region(
                self.scroll_top,
                self.scroll_bottom,
                count_param(first),
                false,
            ),
            (_, 'T') => {
                self.scroll_down_region(self.scroll_top, self.scroll_bottom, count_param(first))
            }
            (_, 'X') => self.erase_chars(count_param(first)),
            (_, '@') => self.insert_chars(count_param(first)),
            (_, 'd') => self.set_cursor_row(values.first().copied().unwrap_or(1) as usize),
            (_, 'm') => self.apply_sgr(&sgr_params(params)),
            (_, 'r') => self.set_scroll_region(values.first().copied(), values.get(1).copied()),
            (_, 's') => self.save_cursor(),
            (_, 'u') => self.restore_cursor(),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore {
            return;
        }
        match byte {
            b'7' => self.save_cursor(),
            b'8' => self.restore_cursor(),
            b'D' => self.newline(),
            b'E' => self.next_line(1),
            b'M' => self.reverse_index(),
            b'c' => self.reset(),
            _ => {}
        }
    }
}

fn blank_row(cols: usize, style: CellStyle) -> Vec<Cell> {
    vec![Cell::blank(style); cols]
}

fn terminal_row(row: usize, cells: &[Cell]) -> TerminalRow {
    TerminalRow {
        row,
        runs: row_runs(cells),
        fingerprint: row_fingerprint(cells),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SgrParam {
    values: Vec<u16>,
}

impl SgrParam {
    fn value(&self) -> u16 {
        self.values.first().copied().unwrap_or(0)
    }

    fn subvalue(&self) -> Option<u16> {
        self.values.get(1).copied()
    }
}

fn row_runs(cells: &[Cell]) -> Vec<CellRun> {
    let mut runs: Vec<CellRun> = Vec::new();
    let Some(last_visible) = cells.iter().rposition(|cell| {
        cell.width > 0 && (!cell.text.is_empty() || cell.style != CellStyle::default())
    }) else {
        return runs;
    };
    for cell in &cells[..=last_visible] {
        if cell.width == 0 {
            continue;
        }
        let text = if cell.text.is_empty() {
            " "
        } else {
            cell.text.as_str()
        };
        if let Some(last) = runs.last_mut() {
            if last.style == cell.style {
                last.text.push_str(text);
                last.width += u16::from(cell.width);
                continue;
            }
        }
        runs.push(CellRun {
            text: text.to_owned(),
            width: u16::from(cell.width),
            style: cell.style.clone(),
        });
    }
    runs
}

fn normalize_wide_cells(cells: &mut [Cell], style: CellStyle) {
    let len = cells.len();
    for index in 0..len {
        if cells[index].width == 0 {
            let valid = index > 0 && cells[index - 1].width == 2;
            if !valid {
                cells[index] = Cell::blank(style.clone());
            }
            continue;
        }
        if cells[index].width == 2 {
            if index + 1 >= len {
                cells[index] = Cell::blank(style.clone());
                continue;
            }
            if cells[index + 1].width != 0 {
                cells[index] = Cell::blank(style.clone());
                cells[index + 1] = Cell::blank(style.clone());
            }
        }
    }
}

fn row_fingerprint(cells: &[Cell]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for cell in cells {
        cell.text.hash(&mut hasher);
        cell.width.hash(&mut hasher);
        cell.style.bold.hash(&mut hasher);
        cell.style.dim.hash(&mut hasher);
        cell.style.italic.hash(&mut hasher);
        cell.style.underline.hash(&mut hasher);
        cell.style.inverse.hash(&mut hasher);
        format!("{:?}", cell.style.foreground).hash(&mut hasher);
        format!("{:?}", cell.style.background).hash(&mut hasher);
    }
    hasher.finish()
}

fn flat_params(params: &Params) -> Vec<u16> {
    params
        .iter()
        .filter_map(|part| part.first().copied())
        .collect()
}

fn sgr_params(params: &Params) -> Vec<SgrParam> {
    params
        .iter()
        .map(|part| SgrParam {
            values: part.to_vec(),
        })
        .collect()
}

fn count_param(value: u16) -> usize {
    usize::from(value.max(1))
}

fn parse_extended_color(params: &[SgrParam]) -> Option<(TerminalColor, usize)> {
    if let [first, rest @ ..] = params {
        if first.values.len() > 1 {
            return match first.values.as_slice() {
                [_, 5, index, ..] => Some((
                    TerminalColor::Palette {
                        index: (*index).min(255) as u8,
                    },
                    0,
                )),
                [_, 2, color @ ..] => parse_colon_rgb(color).map(|color| (color, 0)),
                _ => None,
            };
        }
        match rest {
            [mode, index, ..] if mode.value() == 5 => Some((
                TerminalColor::Palette {
                    index: index.value().min(255) as u8,
                },
                2,
            )),
            [mode, r, g, b, ..] if mode.value() == 2 => Some((
                TerminalColor::Rgb {
                    r: r.value().min(255) as u8,
                    g: g.value().min(255) as u8,
                    b: b.value().min(255) as u8,
                },
                4,
            )),
            _ => None,
        }
    } else {
        None
    }
}

fn parse_colon_rgb(values: &[u16]) -> Option<TerminalColor> {
    let [r, g, b] = match values {
        [0, r, g, b, ..] => [r, g, b],
        [r, g, b, ..] => [r, g, b],
        _ => return None,
    };
    Some(TerminalColor::Rgb {
        r: (*r).min(255) as u8,
        g: (*g).min(255) as u8,
        b: (*b).min(255) as u8,
    })
}
