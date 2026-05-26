# Terminal Engine Direction

Kiri owns terminal lifecycle. A terminal engine owns VT correctness.

## Boundary

- Kiri keeps PTY processes, runtime session identity, paste/inject routing, close, reopen, and background workflow dispatch.
- The terminal engine receives PTY output, tracks VT/render state, and produces visible rows, cursor state, modes, scrollback, and terminal responses.
- The browser can detach and reattach without owning the PTY. Reopen requests a fresh snapshot from the Kiri-owned session.

## Ghostty Path

`libghostty-vt` should replace the fragile VT document model, not the Kiri terminal server.

Target shape:

```text
Kiri registry -> PTY sidecar -> libghostty-vt state -> Kiri frames -> browser renderer
```

This keeps:

- background paste via `terminal.input`
- explicit start via `terminal.open`
- explicit teardown via `terminal.close`
- runtime terminal reuse across UI detach/reattach
- workflow and scratchpad terminal dispatch without DOM focus

Do not embed a self-contained terminal widget that owns process lifecycle. That would make background agents and durable reopen semantics harder to keep correct.
