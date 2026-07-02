# Phase 4 — Ship: delete the Node daemon, package, contract tests

> **Goal**: `kiri-termd` becomes the **only** terminal core. Delete the Node
> `kiriterm-daemon.ts` + the server-side `@xterm/headless` emulator in
> `terminal-registry.ts` + the `KIRI_TERM_CORE` bring-up switch. Wire the build
> the same way `read-model-indexer` is shipped, produce a universal macOS
> binary, and add packaged-app contract tests. No dual-core, no rollback flag —
> the invariant is that every `00-overview.md §5` flow still passes.
>
> **Executor instructions**: Depends on P1+P2 (P3 optional/independent). This
> phase churns packaging and the lockfile — run it after the others land.
>
> **Drift check**:
> `git diff --stat 48acb9f..HEAD -- scripts/build-rust-bins.mjs package.json scripts/sanitize-desktop-package-inputs.mjs tests/server/desktop-package-contract.test.ts`

## Status
- **Priority**: P1 · **Effort**: M · **Risk**: MED · **Depends on**: P1, P2
- **Category**: infra/packaging · **Planned at**: `48acb9f`

## Work items

### 1. Build pipeline
- `scripts/build-rust-bins.mjs`: add `'kiri-termd'` to `binaries`. Build a
  **universal** binary: `cargo build --release` for both `aarch64-apple-darwin`
  and `x86_64-apple-darwin`, then `lipo -create -output` (or ship arch slices).
  `read-model-indexer` currently builds host-only; extend the script to loop
  targets. Copy to `dist/bin/kiri-termd`, `chmod 0755`.
- Ensure `rustup target add x86_64-apple-darwin aarch64-apple-darwin` is
  documented / checked in `doctor`.

### 2. electron-builder packaging
- `package.json build.extraResources`: add
  `{ from: 'dist/bin/kiri-termd', to: 'bin/kiri-termd' }` (next to
  `kiri-read-model-indexer`).
- `scripts/sanitize-desktop-package-inputs.mjs` + normalize/dmg scripts:
  include the new binary; confirm code-signing covers it (hardened runtime,
  `com.apple.security.cs.allow-jit`/`disable-library-validation` only if
  actually needed — prefer not). Notarization must staple the binary.
- Resolve `kiri-termd` at runtime: dev → `target/{debug,release}/kiri-termd`;
  packaged → `process.resourcesPath/bin/kiri-termd`. Centralize in the
  daemon-client resolver (extend the P0 selector).

### 3. Contract tests (packaged app)
- Extend `tests/server/desktop-package-contract.test.ts`: assert
  `bin/kiri-termd` exists in the packaged app, is executable, and
  `--version`/`GET /api/health` responds.
- `pnpm verify:desktop:package` must exercise a Rust-core smoke: spawn
  `kiri-termd`, open a WS shell, assert snapshot+echo.

### 4. Delete the Node core
- Remove `src/server/kiriterm-daemon.ts`, the `@xterm/headless`/`SerializeAddon`
  emulator in `terminal-registry.ts`, node-pty spawn in `terminal-server.ts`,
  the `KIRI_TERM_CORE`/`KIRI_TERMINAL_DAEMON` branches, and now-dead deps
  (`node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `@xterm/addon-unicode11`
  server-side). `kiriterm-daemon-client.ts` now only ever spawns `kiri-termd`.
- Log the core version on startup and in `doctor`.
- Migration note: existing `~/.kiri/kiriterm/sessions/*.json` (old Node format)
  are archived aside on first `kiri-termd` start — do not clobber; accept a
  one-time scrollback reset (document it). No dual-format converter needed since
  there is no rollback path.

### 5. Docs
- Update `README.md` (Development / Desktop Build) with the Rust toolchain
  requirement and `pnpm build:rust`.
- Add a short `plans/rust-terminal-core/README.md` status table (below).

## Acceptance criteria
- [ ] `pnpm install:desktop` produces a signed, notarized app containing a
      universal `bin/kiri-termd`.
- [ ] `pnpm verify:desktop` (smoke + package) passes, including the Rust-core
      terminal smoke.
- [ ] Fresh install: all `00-overview.md §5` flows work; `kiri-termd` is the
      only core (no Node daemon in the bundle).
- [ ] `node-pty` + server-side `@xterm/*` are gone from `dependencies`; asar
      shrinks — note the delta (like plan 008 recorded asar size).

## STOP conditions
- Signing/notarization fails for the embedded binary → stop; resolve
  entitlements before deleting the Node core.
- Any `§5` flow regresses in the packaged app → do **not** delete the Node core
  yet; keep the bring-up switch until the regression is fixed, then finish P4.
