# ADR 0001: Kiri Terminal Stack

## Status

Accepted for implementation.

## Context

Kiri currently relies on `node-pty` on the server and `@xterm/xterm` in the browser. That path keeps terminal truth in the renderer and makes attach/resume, multi-terminal layouts, workflow injection, and agent-grade testing harder than they need to be.

Solo's terminal direction points at a better shape for Kiri: Rust owns the PTY, VTE parsing, terminal document, history, and patch stream; the browser renders snapshots and patches. WezTerm is the vocabulary reference for tabs and panes, not a scope target.

## Decision

Kiri will replace the xterm/node-pty terminal path with a Kiri-owned terminal stack:

- Rust PTY core using `portable-pty`.
- Rust VTE parser/document using `vte` and `unicode-width`.
- Rust-owned snapshots, patch stream, scrollback history, attach/resume state, and paste/inject semantics.
- TypeScript adapter boundary for Kiri server, workflow orchestration, scratchpad triggers, and control APIs.
- Kiri DOM renderer for terminal rows, cursor, selection, scrollback, tabs, and split panes.

There is no long-term xterm fallback lane. Intermediate adapters are allowed only to land the replacement safely; they are not supported alternate behavior.

## Supported Semantics

- Runtime terminals remain agent-bound.
- Shell terminals remain project-bound.
- Workflow-spawned terminals can be created, attached, and injected into.
- Repeated paste/inject targets the same already-open runtime terminal thread.
- Terminal tabs and split panes are first-class layout state.
- Attach/resume uses server-owned snapshots and patch sequence numbers.
- Claude Code, OpenCode, Codex terminal, and shell flows must remain controllable through Kiri.

## Libraries

- `portable-pty = "0.8.1"`
- `vte = "0.15.0"`
- `unicode-width = "0.2.2"`
- `serde`
- `serde_json`
- `rmp-serde`

## Non-Goals

- Full WezTerm clone.
- Full tmux clone.
- Terminal marketplace/plugins.
- Remote terminal domains.
- Changing agent launch command logic unless a terminal test proves it is required.

## Verification Direction

Every functional slice needs tests. The terminal replacement must include:

- Rust document/patch fixture tests.
- TS adapter and server unit tests.
- Terminal harness flows for shell, Codex, Claude Code, and OpenCode.
- E2E flows through current Kiri UI for runtime terminals, shell terminals, workflow paste, repeated paste, tabs, and split panes.
- Performance harnesses with measurable budgets for parse, patch, attach, paste, and render scenarios.
