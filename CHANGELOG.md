# Changelog

## 0.1.1 - 2026-05-12

- Renamed the app from Aether to kiri across package metadata, desktop bundle identity, UI copy, docs, CLI scripts, skills, runtime config, storage paths, IPC channels, and test harnesses.
- Moved local runtime defaults into fresh kiri state at `~/.kiri/userdata/kiri.sqlite` with new `KIRI_*` environment variables.
- Kiri no longer copies or migrates existing Aether databases; projects can be re-added cleanly.
- Renamed desktop artifacts to `kiri.app` and `dist/kiri-<version>-<arch>.dmg`.
- Preserved the existing board, project, session, terminal, and runtime behavior while updating the tests and harnesses to the new kiri names.
