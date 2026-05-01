# Hindsight — Architecture

A desktop market replay and paper trading tool. Solo/internal use, Windows-only (for now).

## Goals

1. Replay historical price action bar-by-bar (play / pause / step / speed / scrub) without hindsight bias.
2. Paper trade against the replayed market with realistic fills, spreads, swaps, and margin.
3. Compute proper position sizes from account equity, risk %, and stop distance — before clicking "buy".
4. Provide drawing tools (trendlines, horizontals, fib retracement/extension, Elliott wave labels) and standard indicators (MA, EMA, MACD, RSI, BOLL, ATR, etc.).
5. Maintain a reviewable trade journal of every paper trade.

## Non-goals (explicitly)

- Live/real trading. No broker integration, ever. This is a learning/practice tool.
- Multi-user. Solo tool, no auth, no cloud sync.
- Mobile. Desktop only.
- Redistribution. Dukascopy data is for personal use; we don't rehost it.

## Technology stack

Versions below are the current stable lines as of the latest architecture review (2026-04). We track latest-stable, not LTS-minus-N, because this is a solo tool with no long-running deployments to support.

| Layer | Choice | Target version | Why |
| --- | --- | --- | --- |
| Shell | Electron | 41.x | Mature, easy Windows packaging, works with the Node libs we need. Ships with Node 24 + Chromium 146. |
| Language | TypeScript | 6.0.x | One language end-to-end; strict mode catches bugs early. |
| Frontend runtime | React | 19.x | Latest stable line; React 18 is past its active phase and has a trail of CVEs we don't want to inherit. |
| Frontend tooling | Vite | 8.x | Standard, fast HMR. |
| Chart | [klinecharts](https://klinecharts.com/en-US/) | 9.x (pinned) until 10.x leaves beta | MIT-licensed; ships drawing tools and ~25 indicators. 10.0.0-beta has breaking API changes (`setDataLoader`, formatter rename, etc.) — we'll revisit at M4. |
| State | Zustand | 5.x | Small, no boilerplate. |
| UI primitives | Radix UI | latest | Accessible, unstyled primitives we theme ourselves. |
| Styling | Tailwind CSS | 4.x | Zero-config, works well with Vite 8. |
| Market data ingest | [`dukascopy-node`](https://github.com/Leo4815162342/dukascopy-node) | 1.46.x | Used for the Dukascopy URL scheme + holiday/availability calendar. We own the bi5 record decoder in `src/shared/dukascopy/bi5.ts` and call native `fetch` (Node ≥ 22) directly so the network seam stays inside our adapter. |
| LZMA decompression | [`lzma`](https://github.com/nmrugg/LZMA-JS) | 2.3.x | Pure-JS LZMA1 decoder for `.bi5` payloads. Pure-JS over `lzma-native` to avoid a second native-module rebuild surface; the bi5 decode runs once per ingest, offline, so the ~2–3× pure-JS slowdown is invisible next to disk + network. |
| Market data store | DuckDB (via [`@duckdb/node-api`](https://www.npmjs.com/package/@duckdb/node-api)) + Parquet archive | DuckDB 1.5.x (exact-pinned) | Columnar, fast analytic queries. Neo Node API is promise-native and ships prebuilt binaries per platform, so no rebuild-against-Electron-ABI step. Hot store is a single DuckDB file; Parquet is the archival/export format (see "Storage tiers" below). |
| App data store | better-sqlite3 | latest matching Electron's Node | Transactional, great for trades/journal/settings. |
| Test runner | Vitest | 4.x | Fast, native TS, ESM-first. |
| TS dev runner | [`tsx`](https://github.com/privatenumber/tsx) | 4.x | Runs TypeScript entry points (e.g. `npm run ingest`) directly without an emit step. Chosen over Node 22's `--experimental-strip-types` because the codebase imports with `.js` suffixes that resolve to `.ts` files (NodeNext + `verbatimModuleSyntax`), which native strip-types does not handle without an additional loader; tsx handles it transparently. Dev-only — never enters the Electron production bundle. |
| Packaging | electron-builder | latest | Produces a Windows installer. |

Version policy: bump majors promptly (within a sprint of release), pin exact versions in `package.json` for DuckDB (the schema is coupled to the engine version) and for Electron-native pieces that rebuild against Electron's Node ABI (`better-sqlite3`); use caret ranges elsewhere.

### Why klinecharts over TradingView Lightweight Charts

Lightweight Charts is rendering-only: no drawing tools, minimal indicators. Our requirements (fibs, trendlines, MACD, etc.) would mean rebuilding half a chart library. klinecharts ships all of that.

### Elliott Wave

No open-source chart lib has a polished Elliott Wave tool. We build one on top of klinecharts' overlay API: a 5-point (optionally 5 + ABC) polyline with auto-labels `1/2/3/4/5/A/B/C`, snappable to swing highs/lows. Small custom module; not a project risk.

## Data strategy

### Ingest

- Source: Dukascopy public datafeed, via `dukascopy-node`.
- Asset classes: forex, metals (XAU/XAG/XPT/XPD), indices (SPX500, NAS100, US30, GER40, UK100, JPN225, etc.), oil (BRENT, WTI), and whatever else Dukascopy exposes.
- User chooses per-instrument, per-year what to download — **no bulk/default downloads**.

### Storage tiers

| Tier | Format | Purpose |
| --- | --- | --- |
| Raw ticks | `.bi5` files on disk, one per symbol/day/hour | Archive + optional tick-accurate fills |
| 1-second OHLCV (hot store) | DuckDB table `bars_1s` in a single database file at `bars/1s.duckdb` | Primary replay source, and the target of the ingest `BarStore`. |
| 1-second OHLCV (archive/export) | Parquet, one file per (symbol, year) at `bars/1s/<SYMBOL>_<YYYY>.parquet` | Long-lived, portable copy produced by a separate export step; not written during ingest. |
| Higher timeframes | Derived on the fly from 1s via DuckDB aggregation | 1m, 5m, 15m, 1h, 4h, 1D |

1s bars are built from every tick, so fill realism is preserved without paying for tick-level storage.

**Why the hot store is DuckDB, not Parquet**: ingest arrives one UTC hour at a time, and Parquet files are immutable — "append one hour to the year's Parquet" means rewrite-the-whole-file, which goes quadratic over 8760 hours/year. The DuckDB table accepts an idempotent DELETE-then-INSERT per hour in a single transaction, making writes O(hour) and giving M3 replay a keyed range query (`symbol + timestamp_ms`) out of the box. The per-year Parquet files become an archival artefact produced on demand or at year-boundary rollover; until the export slice lands (post-M3), the DuckDB file is the full source of truth.

### Disk layout

```
%APPDATA%/Hindsight/
├── data/
│   ├── ticks/<symbol>/<year>/<month>/<day>/<hour>h_ticks.bi5
│   └── bars/
│       ├── 1s.duckdb                       (hot store; live ingest target)
│       └── 1s/<SYMBOL>_<YYYY>.parquet      (archive/export; produced post-ingest)
├── app.sqlite        (trades, journal, drawings, settings)
└── logs/
```

## "No peeking" principle (non-negotiable)

The replay engine owns a single `cursor: Date`. Any query for market data in replay mode is **clipped to `timestamp <= cursor` at the data layer** — not at the rendering layer. This makes it structurally impossible for indicators, drawings, or order logic to leak future data.

- Indicators are recomputed incrementally as the cursor advances; on a backward scrub they reset and rebuild from the visible window.
- A lookback buffer (N bars before replay start) is pre-loaded for indicator warm-up; those bars can be visually greyed out.
- Orders placed during replay only see the bar at or before the cursor.

## Module boundaries

```
src/
├── main/                 Electron main (Node)
│   ├── data/             dukascopy-node wrapper, Parquet writer, DuckDB queries
│   ├── cli/              one-shot runners on top of data/ — first inhabitant: ingestSymbolDay (M2 slice 7)
│   ├── replay/           clock + cursor + event bus
│   ├── broker/           orders, positions, fills, P&L, swap
│   └── persistence/      SQLite repositories
├── shared/               pure TS; importable from both processes
│   ├── instruments.ts    InstrumentSpec catalog (pip size, contract size, ...)
│   ├── sizing.ts         lot-size calculator
│   ├── types.ts          Bar, Tick, Order, Position, Account, ...
│   └── ipc-contract.ts   typed IPC surface
└── renderer/             React app (chart, panels, drawings)
```

**`shared/` has no dependency on Electron, Node-only APIs, DuckDB, or SQLite.** It is pure, synchronous TypeScript and can be unit-tested in milliseconds. The bulk of business logic that is easy to get wrong (sizing, fill math, indicator math, P&L accrual, swap accrual) lives here.

## Development method

Test-first, one small slice at a time. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) for the full workflow — how slices are scoped, the four test categories (unit, breaking, integration, invariant), the adapter pattern for I/O-bound modules, and the Definition of Done checklist.

Summary: tests live next to the module they test (`foo.ts` → `foo.test.ts`). Pure modules in `shared/` are unit-tested directly. Modules that talk to the filesystem, DuckDB, or Dukascopy get adapter interfaces so their callers can be tested with fakes.

## Roadmap

| Milestone | Content |
| --- | --- |
| **M0 — Foundations** *(in progress)* | Project scaffold, TDD setup, **lot size calculator (USD account, USD-quoted instruments)**, instrument spec catalog. |
| M1 — Instrument catalog expansion | USD/XXX pairs (pip value needs current price), crosses (needs cross rate), metals edge cases. |
| M2 — Data ingest | Dukascopy downloader wrapper, `.bi5` → 1s OHLCV Parquet, DuckDB query layer. |
| M3 — Replay engine | Clock with play/pause/speed/step/scrub; cursor-aware data queries; timeframe switch preserves cursor. |
| M4 — Electron shell + chart | Wire up Electron + React + klinecharts rendering a replayed stream. |
| M5 — Drawing tools & indicators | Enable klinecharts drawings + indicators; persist per (instrument, timeframe) to SQLite; custom Elliott Wave tool. |
| M6 — Paper broker | Account + orders + positions + fills + P&L + swap. Order ticket with live sizing preview. |
| M7 — Data Manager UI | Per-instrument, per-year download grid with progress. |
| M8 — Trade journal | Closed-trade log, screenshots, stats (win rate, expectancy, profit factor). |

Each milestone is separately reviewable and useful on its own.

## Deferred decisions

- **Multi-chart layouts** — after M8.
- **Alerts during replay** — after M8.
- **News overlay** — depends on finding a legal, affordable historical news source.
- **macOS/Linux builds** — only if ever needed.
- **Cross-rate service for sizing on crosses** — M1.
