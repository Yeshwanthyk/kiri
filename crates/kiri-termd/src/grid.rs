use std::collections::VecDeque;
use vte::{Params, Parser, Perform};

const DEFAULT_SCROLLBACK: usize = 10_000;

const DEFAULT_ATTR: Attr = Attr {
    bold: false,
    fg: None,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attr {
    pub bold: bool,
    pub fg: Option<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub attr: Attr,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct ScreenText {
    pub lines: Vec<String>,
    pub cursor_x: usize,
    pub cursor_y: usize,
    pub cols: usize,
    pub rows: usize,
}

pub struct Grid {
    cols: usize,
    rows: usize,
    cursor_x: usize,
    cursor_y: usize,
    attr: Attr,
    cells: Vec<Cell>,
    scrollback: VecDeque<Vec<Cell>>,
    saved_normal: Option<(Vec<Cell>, usize, usize)>,
    alt_screen: bool,
    parser: Parser,
}

impl Grid {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        Self {
            cols,
            rows,
            cursor_x: 0,
            cursor_y: 0,
            attr: DEFAULT_ATTR,
            cells: vec![blank_cell(); cols * rows],
            scrollback: VecDeque::new(),
            saved_normal: None,
            alt_screen: false,
            parser: Parser::new(),
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let mut parser = Parser::new();
        std::mem::swap(&mut parser, &mut self.parser);
        {
            let mut performer = GridPerformer { grid: self };
            parser.advance(&mut performer, bytes);
        }
        std::mem::swap(&mut parser, &mut self.parser);
    }

    #[allow(dead_code)]
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let old_cols = self.cols;
        let old_rows = self.rows;
        self.cells = resize_cells(&self.cells, old_cols, old_rows, cols, rows);
        if let Some((saved_cells, saved_x, saved_y)) = &mut self.saved_normal {
            *saved_cells = resize_cells(saved_cells, old_cols, old_rows, cols, rows);
            *saved_x = (*saved_x).min(cols - 1);
            *saved_y = (*saved_y).min(rows - 1);
        }
        self.cols = cols;
        self.rows = rows;
        self.cursor_x = self.cursor_x.min(cols - 1);
        self.cursor_y = self.cursor_y.min(rows - 1);
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn serialize_ansi(&self) -> String {
        let mut output = String::from("\x1b[H\x1b[0m");
        let mut attr = DEFAULT_ATTR;
        if self.alt_screen {
            if let Some((normal_cells, _, _)) = &self.saved_normal {
                self.serialize_scrollback_and_cells(&mut output, &mut attr, normal_cells);
            }
            output.push_str("\x1b[?1049h\x1b[H\x1b[0m");
            attr = DEFAULT_ATTR;
        } else {
            self.serialize_scrollback_and_cells(&mut output, &mut attr, &self.cells);
            output.push_str("\x1b[0m");
            output.push_str(&format!(
                "\x1b[{};{}H",
                self.cursor_y + 1,
                self.cursor_x + 1
            ));
            return output;
        }
        for y in 0..self.rows {
            if y > 0 {
                output.push_str("\r\n");
            }
            let line = self.line_cells(y);
            let end = trimmed_end(line);
            for cell in &line[..end] {
                if cell.attr != attr {
                    output.push_str(&sgr_for(cell.attr));
                    attr = cell.attr;
                }
                output.push(cell.ch);
            }
        }
        output.push_str("\x1b[0m");
        output.push_str(&format!(
            "\x1b[{};{}H",
            self.cursor_y + 1,
            self.cursor_x + 1
        ));
        output
    }

    fn serialize_scrollback_and_cells(&self, output: &mut String, attr: &mut Attr, cells: &[Cell]) {
        for line in &self.scrollback {
            serialize_line(output, attr, line);
            output.push_str("\r\n");
        }
        for y in 0..self.rows {
            if y > 0 {
                output.push_str("\r\n");
            }
            let start = y * self.cols;
            serialize_line(output, attr, &cells[start..start + self.cols]);
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn read_screen(&self) -> ScreenText {
        let lines = (0..self.rows)
            .map(|y| {
                let mut line: String = self.line_cells(y).iter().map(|cell| cell.ch).collect();
                while line.ends_with(' ') {
                    line.pop();
                }
                line
            })
            .collect();
        ScreenText {
            lines,
            cursor_x: self.cursor_x,
            cursor_y: self.cursor_y,
            cols: self.cols,
            rows: self.rows,
        }
    }

    fn put_char(&mut self, ch: char) {
        if self.cursor_x >= self.cols {
            self.newline();
        }
        let index = self.cursor_y * self.cols + self.cursor_x;
        self.cells[index] = Cell {
            ch,
            attr: self.attr,
        };
        self.cursor_x += 1;
        if self.cursor_x >= self.cols {
            self.newline();
        }
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.newline(),
            b'\r' => self.cursor_x = 0,
            0x08 => self.cursor_x = self.cursor_x.saturating_sub(1),
            b'\t' => {
                let next = ((self.cursor_x / 8) + 1) * 8;
                self.cursor_x = next.min(self.cols - 1);
            }
            _ => {}
        }
    }

    fn newline(&mut self) {
        self.cursor_x = 0;
        if self.cursor_y + 1 >= self.rows {
            self.scroll_up(1);
        } else {
            self.cursor_y += 1;
        }
    }

    fn scroll_up(&mut self, count: usize) {
        let count = count.min(self.rows);
        if !self.alt_screen {
            for y in 0..count {
                let start = y * self.cols;
                self.scrollback
                    .push_back(self.cells[start..start + self.cols].to_vec());
                while self.scrollback.len() > DEFAULT_SCROLLBACK {
                    self.scrollback.pop_front();
                }
            }
        }
        for y in 0..(self.rows - count) {
            for x in 0..self.cols {
                self.cells[y * self.cols + x] = self.cells[(y + count) * self.cols + x];
            }
        }
        for y in (self.rows - count)..self.rows {
            for x in 0..self.cols {
                self.cells[y * self.cols + x] = blank_cell();
            }
        }
    }

    fn erase_display(&mut self, mode: usize) {
        match mode {
            0 => {
                self.erase_line();
                for y in (self.cursor_y + 1)..self.rows {
                    for x in 0..self.cols {
                        self.cells[y * self.cols + x] = blank_cell();
                    }
                }
            }
            1 => {
                for y in 0..self.cursor_y {
                    for x in 0..self.cols {
                        self.cells[y * self.cols + x] = blank_cell();
                    }
                }
                for x in 0..=self.cursor_x.min(self.cols - 1) {
                    self.cells[self.cursor_y * self.cols + x] = blank_cell();
                }
            }
            3 => self.scrollback.clear(),
            _ => {
                self.cells.fill(blank_cell());
                self.cursor_x = 0;
                self.cursor_y = 0;
            }
        }
    }

    fn erase_line(&mut self) {
        for x in self.cursor_x..self.cols {
            self.cells[self.cursor_y * self.cols + x] = blank_cell();
        }
    }

    fn csi_dispatch(&mut self, params: &Params, action: char) {
        match action {
            'A' => self.cursor_y = self.cursor_y.saturating_sub(first_param(params, 1)),
            'B' => self.cursor_y = (self.cursor_y + first_param(params, 1)).min(self.rows - 1),
            'C' => self.cursor_x = (self.cursor_x + first_param(params, 1)).min(self.cols - 1),
            'D' => self.cursor_x = self.cursor_x.saturating_sub(first_param(params, 1)),
            'H' | 'f' => {
                let row = first_param(params, 1).saturating_sub(1).min(self.rows - 1);
                let col = nth_param(params, 1, 1).saturating_sub(1).min(self.cols - 1);
                self.cursor_y = row;
                self.cursor_x = col;
            }
            'J' => self.erase_display(first_param(params, 0)),
            'K' => self.erase_line(),
            'h' => {
                if first_param(params, 0) == 1049 {
                    self.enter_alt_screen();
                }
            }
            'l' => {
                if first_param(params, 0) == 1049 {
                    self.exit_alt_screen();
                }
            }
            'm' => self.apply_sgr(params),
            _ => {}
        }
    }

    fn enter_alt_screen(&mut self) {
        if self.alt_screen {
            return;
        }
        self.saved_normal = Some((self.cells.clone(), self.cursor_x, self.cursor_y));
        self.cells.fill(blank_cell());
        self.cursor_x = 0;
        self.cursor_y = 0;
        self.alt_screen = true;
    }

    fn exit_alt_screen(&mut self) {
        if let Some((cells, cursor_x, cursor_y)) = self.saved_normal.take() {
            self.cells = cells;
            self.cursor_x = cursor_x.min(self.cols - 1);
            self.cursor_y = cursor_y.min(self.rows - 1);
        }
        self.alt_screen = false;
    }

    fn apply_sgr(&mut self, params: &Params) {
        let values = params.iter().flat_map(|param| param.iter().copied());
        let mut saw_value = false;
        for value in values {
            saw_value = true;
            match value {
                0 => self.attr = DEFAULT_ATTR,
                1 => self.attr.bold = true,
                22 => self.attr.bold = false,
                30..=37 => self.attr.fg = Some((value - 30) as u8),
                39 => self.attr.fg = None,
                _ => {}
            }
        }
        if !saw_value {
            self.attr = DEFAULT_ATTR;
        }
    }

    fn line_cells(&self, y: usize) -> &[Cell] {
        let start = y * self.cols;
        &self.cells[start..start + self.cols]
    }
}

struct GridPerformer<'a> {
    grid: &'a mut Grid,
}

impl Perform for GridPerformer<'_> {
    fn print(&mut self, ch: char) {
        if !ch.is_control() {
            self.grid.put_char(ch);
        }
    }

    fn execute(&mut self, byte: u8) {
        self.grid.execute(byte);
    }

    fn hook(&mut self, _: &Params, _: &[u8], _: bool, _: char) {}
    fn put(&mut self, _: u8) {}
    fn unhook(&mut self) {}
    fn osc_dispatch(&mut self, _: &[&[u8]], _: bool) {}
    fn esc_dispatch(&mut self, _: &[u8], _: bool, _: u8) {}

    fn csi_dispatch(&mut self, params: &Params, _: &[u8], _: bool, action: char) {
        self.grid.csi_dispatch(params, action);
    }
}

fn blank_cell() -> Cell {
    Cell {
        ch: ' ',
        attr: DEFAULT_ATTR,
    }
}

fn resize_cells(
    cells: &[Cell],
    old_cols: usize,
    old_rows: usize,
    cols: usize,
    rows: usize,
) -> Vec<Cell> {
    let mut next = vec![blank_cell(); cols * rows];
    let copy_rows = old_rows.min(rows);
    let copy_cols = old_cols.min(cols);
    for y in 0..copy_rows {
        for x in 0..copy_cols {
            next[y * cols + x] = cells[y * old_cols + x];
        }
    }
    next
}

fn trimmed_end(line: &[Cell]) -> usize {
    line.iter()
        .rposition(|cell| cell.ch != ' ')
        .map_or(0, |index| index + 1)
}

fn serialize_line(output: &mut String, attr: &mut Attr, line: &[Cell]) {
    let end = trimmed_end(line);
    for cell in &line[..end] {
        if cell.attr != *attr {
            output.push_str(&sgr_for(cell.attr));
            *attr = cell.attr;
        }
        output.push(cell.ch);
    }
}

fn first_param(params: &Params, default: usize) -> usize {
    nth_param(params, 0, default)
}

fn nth_param(params: &Params, index: usize, default: usize) -> usize {
    params
        .iter()
        .nth(index)
        .and_then(|param| param.first().copied())
        .map(usize::from)
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn sgr_for(attr: Attr) -> String {
    let mut codes = vec![0];
    if attr.bold {
        codes.push(1);
    }
    if let Some(fg) = attr.fg {
        codes.push(30 + u16::from(fg));
    }
    format!(
        "\x1b[{}m",
        codes
            .into_iter()
            .map(|code| code.to_string())
            .collect::<Vec<_>>()
            .join(";")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_snapshot_to_equal_screen() {
        let mut grid = Grid::new(20, 5);
        grid.feed(b"hello \x1b[31mred\x1b[0m\r\nnext");

        let snapshot = grid.serialize_ansi();
        let mut restored = Grid::new(20, 5);
        restored.feed(snapshot.as_bytes());

        assert_eq!(restored.read_screen(), grid.read_screen());
    }

    #[test]
    fn handles_cursor_addressing_and_erasure() {
        let mut grid = Grid::new(10, 3);
        grid.feed(b"abc\x1b[2;4Hz\x1b[K");

        let screen = grid.read_screen();
        assert_eq!(screen.lines[0], "abc");
        assert_eq!(screen.lines[1], "   z");
        assert_eq!(screen.cursor_x, 4);
        assert_eq!(screen.cursor_y, 1);
    }

    #[test]
    fn preserves_scrollback_in_snapshot() {
        let mut grid = Grid::new(8, 2);
        grid.feed(b"one\r\ntwo\r\nthree");

        let snapshot = grid.serialize_ansi();

        assert!(snapshot.contains("one"));
        assert!(snapshot.contains("two"));
        assert!(snapshot.contains("three"));
    }

    #[test]
    fn restores_normal_screen_after_alt_screen() {
        let mut grid = Grid::new(20, 3);
        grid.feed(b"normal\x1b[?1049halt\x1b[?1049l");

        assert_eq!(grid.read_screen().lines[0], "normal");
    }

    #[test]
    fn serializes_active_alt_screen_mode() {
        let mut grid = Grid::new(20, 3);
        grid.feed(b"normal\x1b[?1049halt");

        let snapshot = grid.serialize_ansi();

        assert!(snapshot.contains("\x1b[?1049h"));
        assert!(snapshot.contains("alt"));
    }

    #[test]
    fn resizes_saved_normal_buffer_while_in_alt_screen() {
        let mut grid = Grid::new(20, 3);
        grid.feed(b"normal\x1b[?1049halt");
        grid.resize(30, 4);
        let snapshot = grid.serialize_ansi();
        grid.feed(b"\x1b[?1049l");

        assert!(snapshot.contains("\x1b[?1049h"));
        assert_eq!(grid.cols(), 30);
        assert_eq!(grid.rows(), 4);
        assert_eq!(grid.read_screen().lines[0], "normal");
    }

    #[test]
    fn clears_scrollback_with_csi_3j() {
        let mut grid = Grid::new(8, 2);
        grid.feed(b"one\r\ntwo\r\nthree\x1b[3J");

        let snapshot = grid.serialize_ansi();

        assert!(!snapshot.contains("one"));
        assert!(snapshot.contains("three"));
    }
}
