use std::collections::HashMap;

use crate::protocol::{TerminalId, TerminalKind};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalSessionEntry {
    pub terminal_id: TerminalId,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub kind: TerminalKind,
    pub cwd: String,
}

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: HashMap<TerminalId, TerminalSessionEntry>,
}

impl TerminalRegistry {
    pub fn insert(&mut self, session: TerminalSessionEntry) {
        self.sessions.insert(session.terminal_id.clone(), session);
    }

    pub fn get(&self, terminal_id: &str) -> Option<&TerminalSessionEntry> {
        self.sessions.get(terminal_id)
    }

    pub fn remove(&mut self, terminal_id: &str) -> Option<TerminalSessionEntry> {
        self.sessions.remove(terminal_id)
    }
}
