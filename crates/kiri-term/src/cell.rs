use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub text: String,
    pub width: u8,
    pub style: CellStyle,
}

impl Cell {
    pub fn blank(style: CellStyle) -> Self {
        Self {
            text: String::new(),
            width: 1,
            style,
        }
    }

    pub fn continuation(style: CellStyle) -> Self {
        Self {
            text: String::new(),
            width: 0,
            style,
        }
    }

    pub fn printable(text: String, width: u8, style: CellStyle) -> Self {
        Self { text, width, style }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellStyle {
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub foreground: Option<TerminalColor>,
    pub background: Option<TerminalColor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalColor {
    Palette { index: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRun {
    pub text: String,
    pub width: u16,
    pub style: CellStyle,
}
