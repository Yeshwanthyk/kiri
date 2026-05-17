# Changelog

## 0.1.6 - 2026-05-17

- Added compact agent-first MCP/CLI controls with `kiri_get`, `kiri_do`, `pnpm kiri:ctl call`, and `pnpm kiricli mcp`.
- Added durable workflow runs with validation, creation, dispatch, retrigger, track/untrack, archive, and restore operations.
- Added workflow scratchpad support so launch items can attach scratchpad blocks and scratchpad-only items can be tracked without launching sessions.
- Added terminal workflow dispatch: Kiri creates terminal sessions, queues workflow bodies as terminal input, and pastes them into spawned runtime PTYs when the desktop backend owns the launch.
- Added backend control routing so CLI/MCP workflow dispatch can route through the running desktop backend instead of spawning terminals in short-lived helper processes.
- Hardened backend control behavior with token files, strict operation-shaped errors, no silent fallback on auth/transport failures, and `0600` token file permissions.
- Added OpenCode as a terminal runtime.
- Improved terminal scrollback retention and replay behavior across tab changes.
- Added/expanded agent harness and server tests for workflow operations, MCP proxy dispatch, terminal input queueing, real PTY paste, archive/restore, and backend-control failure handling.

## 0.1.1 - 2026-05-12

- Renamed the app from Aether to kiri across package metadata, desktop bundle identity, UI copy, docs, CLI scripts, skills, runtime config, storage paths, IPC channels, and test harnesses.
- Moved local runtime defaults into fresh kiri state at `~/.kiri/userdata/kiri.sqlite` with new `KIRI_*` environment variables.
- Kiri no longer copies or migrates existing Aether databases; projects can be re-added cleanly.
- Renamed desktop artifacts to `kiri.app` and `dist/kiri-<version>-<arch>.dmg`.
- Preserved the existing board, project, session, terminal, and runtime behavior while updating the tests and harnesses to the new kiri names.
