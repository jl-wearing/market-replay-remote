/**
 * Pip value in USD — pure kernel used by sizing and (later) the order ticket.
 *
 * Computes the USD value of a one-pip move for one standard lot of the given
 * instrument, branching on the instrument's category:
 *
 * - `direct`  (quote = USD): `pipValueUsd = pipSize × contractSize`.
 *   No price inputs required.
 * - `inverse` (base = USD, quote ≠ USD): `pipValueUsd = pipSize × contractSize / instrumentPrice`.
 *   `instrumentPrice` required.
 * - `cross`   (neither USD): `pipValueUsd = pipSize × contractSize × quoteToUsdRate`.
 *   `quoteToUsdRate` required. The instrument's own price does not enter the
 *   formula — only the quote-currency → USD conversion matters.
 *
 * Callers in higher layers (order ticket, replay broker) are responsible for
 * fetching the current market prices at the replay cursor and passing them in.
 * This module does no I/O and no clamping.
 */

import {
  instrumentCategory,
  type InstrumentCategory,
  type InstrumentSpec,
} from "./instruments.js";

export interface PipValueInput {
  instrument: InstrumentSpec;
  /**
   * Current market price of `instrument`, in its own quote currency.
   * Required iff the instrument is `inverse`. Ignored for `direct` and
   * `cross` (both branches that don't use the instrument's own price).
   */
  instrumentPrice?: number;
  /**
   * USD value of 1 unit of `instrument.quoteCurrency` at the same timestamp
   * as `instrumentPrice`. Required iff the instrument is `cross`. Ignored
   * for `direct` and `inverse`.
   *
   * Example: for EURJPY and GER40 (both quote = non-USD), the caller computes
   * this from the concurrent USD/<quote> rate and passes it in. For EURJPY
   * and any other JPY-quoted cross, `quoteToUsdRate = 1 / USDJPY`.
   */
  quoteToUsdRate?: number;
}

export interface PipValueResult {
  /** USD value of one pip move at 1 standard lot. Always > 0 for valid input. */
  pipValueUsd: number;
  /** Resolved instrument category. Useful for UI labels and downstream math. */
  category: InstrumentCategory;
}

/**
 * Thrown when `pipValueInUsd` is called with missing, NaN, Infinity, zero, or
 * negative `instrumentPrice` / `quoteToUsdRate` where that input is required
 * by the instrument's category.
 */
export class InvalidPipValueInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPipValueInputError";
  }
}

/**
 * Compute the USD value of a one-pip move at 1 standard lot of `input.instrument`.
 *
 * Required inputs by category (see module header for formulas):
 * - direct: none.
 * - inverse: `instrumentPrice` (quote currency per 1 unit of base).
 * - cross: `quoteToUsdRate` (USD per 1 unit of quote currency).
 *
 * Irrelevant inputs are accepted and ignored — this keeps callers that always
 * forward "every price they have" simple. Missing required inputs, or any
 * non-finite / non-positive price or rate, throw `InvalidPipValueInputError`.
 */
export function pipValueInUsd(input: PipValueInput): PipValueResult {
  const { instrument, instrumentPrice, quoteToUsdRate } = input;
  const category = instrumentCategory(instrument);
  const kernel = instrument.pipSize * instrument.contractSize;

  switch (category) {
    case "direct":
      return { pipValueUsd: kernel, category };

    case "inverse": {
      if (instrumentPrice === undefined) {
        throw new InvalidPipValueInputError(
          `instrumentPrice is required for ${instrument.symbol} ` +
            `(inverse instrument: base=USD, quote=${instrument.quoteCurrency}).`,
        );
      }
      assertFinitePositive("instrumentPrice", instrumentPrice);
      return { pipValueUsd: kernel / instrumentPrice, category };
    }

    case "cross": {
      if (quoteToUsdRate === undefined) {
        throw new InvalidPipValueInputError(
          `quoteToUsdRate is required for ${instrument.symbol} ` +
            `(cross instrument: base=${instrument.baseCurrency}, quote=${instrument.quoteCurrency}).`,
        );
      }
      assertFinitePositive("quoteToUsdRate", quoteToUsdRate);
      return { pipValueUsd: kernel * quoteToUsdRate, category };
    }
  }
}

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new InvalidPipValueInputError(
      `${name} must be a finite number, got ${value}`,
    );
  }
  if (value <= 0) {
    throw new InvalidPipValueInputError(`${name} must be > 0, got ${value}`);
  }
}
