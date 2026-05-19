use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::protocol::{TerminalHistoryRow, TerminalRow};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryDelta {
    pub history_seq: u64,
    pub trimmed: usize,
    pub rows: Vec<TerminalHistoryRow>,
}

#[derive(Clone, Debug)]
pub struct HistoryRing {
    capacity: usize,
    rows: VecDeque<TerminalRow>,
    seq: u64,
    next_row_id: u64,
}

impl HistoryRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            rows: VecDeque::with_capacity(capacity.min(1024)),
            seq: 0,
            next_row_id: 0,
        }
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn rows(&self) -> Vec<TerminalHistoryRow> {
        let first_id = self.next_row_id.saturating_sub(self.rows.len() as u64);
        self.rows
            .iter()
            .enumerate()
            .map(|(index, row)| TerminalHistoryRow {
                id: first_id + index as u64,
                row: row.clone(),
            })
            .collect()
    }

    pub fn push(&mut self, mut row: TerminalRow) -> TerminalHistoryDelta {
        self.seq += 1;
        row.row = self.rows.len();
        let mut trimmed = 0;
        if self.rows.len() == self.capacity {
            self.rows.pop_front();
            trimmed = 1;
        }
        let id = self.next_row_id;
        self.next_row_id += 1;
        self.rows.push_back(row.clone());
        TerminalHistoryDelta {
            history_seq: self.seq,
            trimmed,
            rows: vec![TerminalHistoryRow { id, row }],
        }
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}
