/**
 * Opt-in integration test: hits the real Dukascopy datafeed.
 *
 * Off by default in `npm test`. To run: `HINDSIGHT_RUN_NETWORK=1 npm test`
 * (PowerShell: `$env:HINDSIGHT_RUN_NETWORK=1; npm test`).
 *
 * What this test pins down:
 * - The default `createDukascopyClient()` (real `fetch`, real LZMA) returns
 *   a decompressed bi5 payload whose length is a multiple of 20 (the bi5
 *   record size).
 * - The bytes then feed through our pure `decodeBi5Records` and produce
 *   ticks that all fall inside the requested UTC hour and have plausible
 *   bid/ask values.
 *
 * The test deliberately picks a long-settled historical hour (EURUSD
 * 2024-01-15 10:00 UTC) so the response stays byte-stable over time.
 */

import { describe, expect, it } from "vitest";
import { decodeBi5Records } from "../../shared/dukascopy/bi5.js";
import { catalogToDukascopy } from "../../shared/dukascopy/symbolMap.js";
import { createDukascopyClient } from "./dukascopyClient.js";

const RUN_NETWORK = process.env.HINDSIGHT_RUN_NETWORK === "1";
const ONE_HOUR_MS = 3_600_000;

// 2024-01-15 10:00:00 UTC — a settled, mid-London-session hour.
const HOUR_MS = Date.UTC(2024, 0, 15, 10, 0, 0, 0);

describe.skipIf(!RUN_NETWORK)("createDukascopyClient (network) — real datafeed", () => {
  it(
    "fetches one hour of EURUSD bi5 bytes that decode to a non-empty, in-hour Tick[]",
    async () => {
      const client = createDukascopyClient();
      const symbol = catalogToDukascopy("EURUSD");
      const decompressed = await client.fetchHour({
        symbol,
        hourStartMs: HOUR_MS,
      });

      expect(decompressed).toBeInstanceOf(Uint8Array);
      expect(decompressed.length).toBeGreaterThan(0);
      expect(decompressed.length % 20).toBe(0);

      const ticks = decodeBi5Records(decompressed, HOUR_MS, 1e5);
      expect(ticks.length).toBeGreaterThan(0);

      for (const tick of ticks) {
        expect(tick.timestampMs).toBeGreaterThanOrEqual(HOUR_MS);
        expect(tick.timestampMs).toBeLessThan(HOUR_MS + ONE_HOUR_MS);
        // EURUSD in Jan 2024 traded ~1.05–1.12. Wide envelope, just sanity.
        expect(tick.bid).toBeGreaterThan(0.5);
        expect(tick.bid).toBeLessThan(2);
        expect(tick.ask).toBeGreaterThanOrEqual(tick.bid);
      }
    },
    30_000,
  );
});
