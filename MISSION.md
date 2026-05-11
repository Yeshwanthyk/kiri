# Mission

Move Pican runtime lifecycle behavior toward Effect in safe phases, preserving runtime-specific protocol ownership while adding invariants, tests, review, and logical commits.

# Done Criteria

- [x] Phase 1 extracts boring shared Promise-compatible lifecycle behavior.
- [x] Phase 1 has Quint lifecycle invariants and focused tests.
- [x] Phase 1 review feedback is fixed and ready to commit.
- [x] Phase 2 makes lifecycle helpers Effect-native while runtime exports stay Promise-compatible.
- [x] Phase 2 uses Effect tests and is reviewed/fixed/ready to commit.
- [ ] Phase 3 moves Codex, Claude, then Pi protocol cores to Effect where appropriate.
- [ ] Phase 3 is tested, reviewed, fixed, and committed per runtime chunk.
- [ ] Phase 4 introduces Layers only where they replace real boundaries in tests.
- [ ] Final build/test/lint pass is green.

# Guardrails

- Preserve protocol logic inside runtime-specific files until its dedicated phase.
- Do not touch unrelated dirty UI edits unless needed for this mission.
- Keep changes behavior-preserving unless a lifecycle invariant requires a small correction.
- Run subagent review for each coherent phase/chunk and fix confirmed findings before commit.

# Critical Learnings

- Quint is available locally; use simple pure state models first, then executable action specs only where needed.
- Review caught that Pi reset/stop semantics must remain idle/silent in Phase 1; only queue and diff helpers are shared for Pi for now.
- Phase 2 keeps typed `RuntimeLifecycleError` inside Effect but unwraps `Runtime turn failed` at Promise runtime boundaries to preserve provider error messages.
- Codex protocol-core Effect migration reviewed clean; optional future hardening is direct coverage for non-missing adapter failures preserving provider error identity.
