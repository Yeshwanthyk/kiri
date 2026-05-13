# Rename Aether to kiri

## Decisions

- Product/app name: `kiri`.
- Package and scripts move from `aether` to `kiri`.
- Storage namespace moves from `.aether/` to `.kiri/`.
- Environment variables move from `AETHER_*` to `KIRI_*`.
- No command/env compatibility aliases are kept.
- Default SQLite data lives under `~/.kiri/userdata/kiri.sqlite`.
- Kiri starts from its own state; existing Aether databases are not copied or migrated.

## Checklist

- [x] Rename package metadata and npm scripts.
- [x] Rename project-management script and command help.
- [x] Rename docs and agent notes.
- [x] Rename visible app branding and page metadata.
- [x] Rename theme/module/component/internal symbols where they carry the product name.
- [x] Rename storage paths from `.aether/` to `.kiri/`.
- [x] Rename database filenames from `aether.sqlite` to `kiri.sqlite`.
- [x] Rename environment variables from `AETHER_*` to `KIRI_*`.
- [x] Update default seeded project to `kiri` / `kiri Orchestrator`.
- [x] Update tests, fixtures, and e2e paths.
- [x] Verify build and relevant tests.
