# Rename Pican to Aether

## Decisions

- Product/app name: `Aether`.
- Package and scripts move from `pican` to `aether`.
- Storage namespace moves from `.pican/` to `.aether/`.
- Environment variables move from `PICAN_*` to `AETHER_*`.
- No backward compatibility or data migration is required. Existing `.pican/` data can remain unused.
- Default SQLite data starts fresh under `.aether/aether.sqlite`.

## Checklist

- [x] Rename package metadata and npm scripts.
- [x] Rename project-management script and command help.
- [x] Rename docs and agent notes.
- [x] Rename visible app branding and page metadata.
- [x] Rename theme/module/component/internal symbols where they carry the product name.
- [x] Rename storage paths from `.pican/` to `.aether/`.
- [x] Rename database filenames from `pican.sqlite` to `aether.sqlite`.
- [x] Rename environment variables from `PICAN_*` to `AETHER_*`.
- [x] Update default seeded project to `aether` / `Aether Orchestrator`.
- [x] Update tests, fixtures, and e2e paths.
- [x] Verify build and relevant tests.
