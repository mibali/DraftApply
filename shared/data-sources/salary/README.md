# Salary benchmarks (official sources only)

This folder contains the **deterministic** manifest + compact snapshot used by `shared/salary-benchmark-service.js`.

## What is committed

- `sources.json` — official-source manifest (URLs + cadence + licensing notes).
- `salary-benchmarks.snapshot.json` — **compact** derived snapshot (no raw downloads).
- `mappings/` — small, deterministic mappings from official occupation codes → DraftApply role profiles.

## What is *not* committed

Raw official datasets (XLS/XLSX/ZIP/TXT) are intentionally excluded from git.

Put downloads in:

- `shared/data-sources/salary/raw/` (gitignored)

## Refreshing the snapshot

1. Download the latest official datasets (no paid/private APIs).
2. Save them under `shared/data-sources/salary/raw/` using the filenames referenced in `sources.json`.
3. Run:

```bash
npm run refresh:salary-benchmarks
```

The refresh script:

- Computes SHA-256 checksums for each raw input.
- Updates `salary-benchmarks.snapshot.json` only when a source checksum/version changes.
- Keeps the committed snapshot compact and role-profile oriented.

