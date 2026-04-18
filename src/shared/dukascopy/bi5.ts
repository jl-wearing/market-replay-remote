/**
 * Dukascopy bi5 tick-record decoder.
 *
 * Dukascopy publishes one `.bi5` file per (instrument, UTC year, month, day,
 * hour). After LZMA1 decompression (done upstream — see slice 2), the payload
 * is a packed sequence of 20-byte big-endian records:
 *
 *     u32  ms from the top of the hour
 *     u32  ask price × priceScale
 *     u32  bid price × priceScale
 *     f32  ask volume (Dukascopy units: millions of base asset)
 *     f32  bid volume
 *
 * `priceScale` is 1e5 for most instruments and 1e3 for JPY-quoted pairs. The
 * caller derives it from the instrument catalog and passes it in; this module
 * deliberately does not import `InstrumentSpec` so it stays usable for
 * anything with the same wire format.
 *
 * This module is pure: no I/O, no network, no decompression. Given byte-
 * identical input it returns byte-identical output.
 */

import type { Tick } from "../types.js";

const RECORD_BYTES = 20;
const MS_PER_HOUR = 3_600_000;

/**
 * Thrown when the input byte buffer does not conform to the bi5 wire format,
 * or when a numeric parameter is missing / non-finite / non-positive. Data-
 * quality concerns (e.g. inverted spreads) are not parse errors and do not
 * throw here.
 */
export class InvalidBi5Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBi5Error";
  }
}

/**
 * Decode an already-decompressed bi5 payload into a chronologically ordered
 * array of `Tick`s.
 *
 * Inputs:
 * - `decompressed` — LZMA-decompressed bi5 payload. Must have
 *   `length % 20 === 0`; any other length throws `InvalidBi5Error`.
 * - `hourStartMs` — absolute epoch ms at the top of the UTC hour this blob
 *   covers. Each tick's `timestampMs` is `hourStartMs` plus the record's
 *   intra-hour offset.
 * - `priceScale` — positive finite divisor used by Dukascopy when encoding
 *   prices. 1e5 for most instruments, 1e3 for JPY-quoted pairs.
 *
 * Output: a `Tick[]` in the same order as the input records. Length is
 * exactly `decompressed.length / 20`.
 *
 * Throws `InvalidBi5Error` on: buffer length not a multiple of 20; NaN /
 * Infinity / non-positive `priceScale`; NaN / Infinity `hourStartMs`; any
 * record whose intra-hour offset is >= 3 600 000 (would span hours and
 * indicates a corrupt file).
 */
export function decodeBi5Records(
  decompressed: Uint8Array,
  hourStartMs: number,
  priceScale: number,
): Tick[] {
  if (!Number.isFinite(hourStartMs)) {
    throw new InvalidBi5Error(
      `hourStartMs must be a finite number, got ${hourStartMs}`,
    );
  }
  if (!Number.isFinite(priceScale)) {
    throw new InvalidBi5Error(
      `priceScale must be a finite number, got ${priceScale}`,
    );
  }
  if (priceScale <= 0) {
    throw new InvalidBi5Error(`priceScale must be > 0, got ${priceScale}`);
  }
  if (decompressed.length % RECORD_BYTES !== 0) {
    throw new InvalidBi5Error(
      `bi5 payload length ${decompressed.length} is not a multiple of 20 ` +
        `(one record = 20 bytes)`,
    );
  }

  const view = new DataView(
    decompressed.buffer,
    decompressed.byteOffset,
    decompressed.byteLength,
  );
  const count = decompressed.length / RECORD_BYTES;
  const ticks: Tick[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * RECORD_BYTES;
    const msFromHourStart = view.getUint32(base, false);
    const askRaw = view.getUint32(base + 4, false);
    const bidRaw = view.getUint32(base + 8, false);
    const volumeAsk = view.getFloat32(base + 12, false);
    const volumeBid = view.getFloat32(base + 16, false);

    if (msFromHourStart >= MS_PER_HOUR) {
      throw new InvalidBi5Error(
        `record ${i}: msFromHourStart=${msFromHourStart} >= 3_600_000 ` +
          `(would span hours; indicates corrupt payload)`,
      );
    }

    ticks[i] = {
      timestampMs: hourStartMs + msFromHourStart,
      bid: bidRaw / priceScale,
      ask: askRaw / priceScale,
      volumeBid,
      volumeAsk,
    };
  }

  return ticks;
}
