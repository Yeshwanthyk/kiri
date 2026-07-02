# Phase 3 — Native protocol: structured grid diffs, resumable attach, paged history

> **Goal**: Unlock the big performance wins now that the authoritative grid
> lives in Rust. Move the frontend to a **binary patch protocol** — frame
> patches (damage-only) + epoch/seq resumable attach + split live-snapshot/
> paged-history — and **delete** the ANSI-passthrough path from P0. This is
> where full-screen TUIs (codex/claude/opencode/vim) get dramatically cheaper.
>
> **Executor instructions**: Depends on P2 being stable. No back-compat: the
> frontend is edited to speak the patch protocol directly; there is no
> negotiation or v1 fallback to maintain. Steal the shapes from Solo
> (`00-overview.md §6`).
>
> **Drift check**:
> `git diff --stat 48acb9f..HEAD -- src/lib/contracts.ts src/components/kiri-board/terminal-panel.tsx`

## Status
- **Priority**: P2 · **Effort**: L · **Risk**: MED · **Depends on**: P2
- **Category**: perf · **Planned at**: `48acb9f`

## Design

### 1. Damage tracking in the grid
- Grid marks dirty cells/lines per `feed()`. After each PTY read burst, compute
  a **frame patch**: changed rows as `(row, [CellRun...])`, cursor, mode flags
  (alt-screen, etc.) — mirror Solo's `FrameRow`/`CellRun`/`TerminalFramePatchBytes`.
- Coalesce patches per animation tick (~16ms) to bound frame rate.

### 2. Binary WS frames (the only terminal path)
- Server→client: `frame_snapshot` (full grid, binary), `frame_patch`
  (damage-only, binary), `history_delta`, `status`. Client→server: `input`,
  `resize`, `ack{frameSeq,bytes}`.
- Encoding: length-prefixed binary (bincode/MessagePack). Keep JSON for the
  `/api/*` control plane; binary only for the hot terminal path
  (Solo's `_binary` split). The P0 ANSI `snapshot`/`data` frames are removed.

### 3. Resumable attach handshake (epoch + screen_seq)
- Daemon assigns a `run_epoch` per PTY generation and a monotonic `screen_seq`
  per applied frame. Client attaches with `{knownRunEpoch, knownScreenSeq}`:
  - same epoch & seq reachable → send patches from `knownScreenSeq+1` (resume,
    no full repaint);
  - stale/unknown → send `frame_snapshot` then patches.
- This replaces "full ANSI snapshot on every reconnect" for the common reload
  case (maps onto today's `generation`+`outputSeq`; Solo `attach_terminal
  knownRunEpoch knownScreenSeq`).

### 4. Split live snapshot vs paged history
- `frame_snapshot` = current viewport (fast paint).
- `fetch_terminal_history{beforeLineId, limit}` = paged immutable scrollback,
  lazily loaded as the user scrolls up (Solo `fetch_terminal_history`). Removes
  the "serialize all 10k scrollback lines on attach" cost.

### 5. Frontend renderer path
- Keep xterm.js as the renderer. Rewrite `terminal-panel.tsx`'s socket client
  to apply `frame_patch` (minimal cell updates written into xterm, or via a
  thin grid-diff → xterm write shim) and `frame_snapshot`/`history_delta`.
- Replace the v1 frame schemas in `contracts.ts` with the patch schemas (the
  ANSI `snapshot`/`data` union is deleted, not kept alongside).

## Acceptance criteria
- [ ] With `proto=2`, a full-screen TUI (vim, codex TUI) sends **only** damaged
      cells: measured bytes/sec down ≥5× vs v1 on a scripted vim/htop session.
- [ ] Electron reload with resumable attach repaints with **no** full snapshot
      when the epoch/seq is still reachable.
- [ ] Scrolling up lazily pages history; initial attach no longer serializes
      full scrollback.
- [ ] All `00-overview.md §5` flows still pass on the patch protocol (the
      control-plane `/api/*` is unchanged; only the WS terminal path changed).
- [ ] Perf gate added (`tests/server/perf-gates.test.ts` analog) asserting the
      bytes-out reduction.

## Tests
- `crates/kiri-termd/tests/damage.rs` — patch correctness (apply patches to a
  blank grid == full grid).
- `crates/kiri-termd/tests/resume.rs` — epoch/seq resume vs stale → snapshot.
- Frontend: v2 client applies a patch stream to xterm and matches a v1 render.

## STOP conditions
- Patch-applied grid ever diverges from the authoritative grid → stop; a
  desync is worse than v1's cost. Ship v2 only when damage correctness is
  property-tested.
