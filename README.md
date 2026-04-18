# Hindsight

Desktop market replay and paper trading tool — forex, metals, indices — for solo practice.

> Early scaffold. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full plan.

## Requirements

- Windows 10/11
- Node.js 22 or newer (Electron 41 ships with Node 24; 22 LTS is the floor for local tooling)

## Getting started

```powershell
npm install
npm test
```

## Project layout

```
src/
├── main/        Electron main process (not yet scaffolded)
├── shared/      Pure TypeScript — business logic, safe to import anywhere
└── renderer/    React UI (not yet scaffolded)
```

## Development method

Test-first, one small slice at a time. Every slice ships four categories of tests — core behaviour, edge cases, breaking tests (must-throw / must-not-happen), and invariants — before any implementation code is written. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the full playbook, Definition of Done checklist, and anti-patterns.

## Status

- [x] M0 — Project scaffold + lot size calculator (USD-quoted instruments)
- [ ] M1 — Expanded instrument sizing (USD/XXX, crosses)
- [ ] M2 — Data ingest from Dukascopy
- [ ] M3 — Replay engine
- [ ] M4 — Electron shell + chart
- [ ] M5 — Drawing tools & indicators
- [ ] M6 — Paper broker
- [ ] M7 — Data Manager UI
- [ ] M8 — Trade journal
