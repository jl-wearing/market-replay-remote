# Hindsight

Desktop market replay and paper trading tool — forex, metals, indices — for solo practice.

> Early scaffold. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full plan.

## Requirements

- Windows 10/11
- Node.js 22 or newer (Electron 41 ships with Node 24; 22 LTS is the floor for local tooling)

## Getting started

```powershell
npm install
npm test          # full suite (Vitest)
npm run typecheck # tsc --noEmit, strict
```

## Data ingest

Download one UTC calendar day of ticks from the Dukascopy datafeed, decode
them to 1-second OHLCV bars, and write them to the DuckDB hot store under
`<root>/bars/1s.duckdb`:

```powershell
npm run ingest -- --symbol XAGUSD --day 2023-06-01 --root C:/data
```

Add `--resume` for long backfills: it **skips hours already in the store**
and **continues past per-hour failures** (collected in the run's stats
rather than aborting), so a transient datafeed error doesn't lose the whole
day. A resumed run exits `0` only when every hour is accounted for, so it is
safe to re-run until it succeeds:

```powershell
npm run ingest -- --symbol XAGUSD --day 2023-06-01 --root C:/data --resume
```

## Project layout

```
src/
├── main/        Electron main process
│   ├── data/    Dukascopy adapter, bi5 price scale, ingest orchestrator, DuckDB bar store
│   └── cli/     One-shot runners: ingestSymbolDay, resumable runner, `npm run ingest` shim
├── shared/      Pure TypeScript — business logic, safe to import anywhere
└── renderer/    React UI (not yet scaffolded)
```

## Development method

Test-first, one small slice at a time. Every slice ships four categories of tests — core behaviour, edge cases, breaking tests (must-throw / must-not-happen), and invariants — before any implementation code is written. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the full playbook, Definition of Done checklist, and anti-patterns.

## Status

- [x] M0 — Project scaffold + lot size calculator (USD-quoted instruments)
- [x] M1 — Expanded instrument sizing (USD/XXX, crosses, metals)
- [ ] M2 — Data ingest from Dukascopy *(pipeline + `npm run ingest` CLI done, incl. `--resume`; full-year acceptance pass remaining)*
- [ ] M3 — Replay engine
- [ ] M4 — Electron shell + chart
- [ ] M5 — Drawing tools & indicators
- [ ] M6 — Paper broker
- [ ] M7 — Data Manager UI
- [ ] M8 — Trade journal
