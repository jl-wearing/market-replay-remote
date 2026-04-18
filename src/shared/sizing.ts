/**
 * Position sizing — USD account, all three instrument categories.
 *
 * Given an account balance, a risk percentage, a stop-loss distance in pips,
 * and an instrument (plus any market rates the instrument needs to resolve
 * its USD pip value), compute the lot size that risks at most the intended
 * amount if the stop is hit. Lots are rounded DOWN to `lotStep` so the
 * realised risk never exceeds the intended risk.
 *
 * Pip-value math is delegated to `pipValueInUsd`; sizing owns only the
 * intended-risk calculation, ideal-lot computation, rounding, and clamping
 * against `minLots` / `maxLots`. Which market rates the caller must supply
 * depends on the instrument's category — see `pipValueInUsd` for details:
 *
 * - direct   (quote = USD): no rates required.
 * - inverse  (base = USD):  `instrumentPrice` required.
 * - cross    (neither USD): `quoteToUsdRate` required.
 *
 * Missing or non-finite/non-positive rates propagate as
 * `InvalidPipValueInputError` from the pip-value kernel; the caller should
 * treat it the same as a numeric `InvalidSizingInputError`.
 */

import type { InstrumentCategory } from "./instruments.js";
import { pipValueInUsd } from "./pip-value.js";

export interface PositionSizeInput {
  accountBalanceUsd: number;
  /** Percentage of account to risk, e.g. 1 for 1 %. Must be in (0, 100]. */
  riskPercent: number;
  /** Distance from entry to stop loss, in pips of the instrument. Must be > 0. */
  stopLossPips: number;
  instrument: import("./instruments.js").InstrumentSpec;
  /**
   * Current market price of the instrument, in its quote currency. Required
   * iff the instrument is `inverse`. See `pipValueInUsd` for semantics.
   */
  instrumentPrice?: number;
  /**
   * USD value of 1 unit of the instrument's quote currency, at the same
   * timestamp as `instrumentPrice`. Required iff the instrument is `cross`.
   */
  quoteToUsdRate?: number;
  /** Smallest allowed lot increment. Default 0.01 (micro lot). */
  lotStep?: number;
  /** Minimum tradable lot size. Sizes below this are clamped to 0. Default 0.01. */
  minLots?: number;
  /** Maximum tradable lot size. Caller's broker/policy cap. Default 100. */
  maxLots?: number;
}

export interface PositionSizeResult {
  /** Lots actually sizeable given rounding and limits. May be 0. */
  lots: number;
  /** lots × contractSize, in units of the base asset. */
  units: number;
  /** USD value of one pip at the computed lot size. */
  pipValueUsd: number;
  /** Intended risk before rounding (balance × risk%). */
  intendedRiskUsd: number;
  /** Actual USD at risk given the rounded lot size. Always ≤ intendedRiskUsd. */
  riskAmountUsd: number;
  /** Resolved instrument category; matches `pipValueInUsd` for the same input. */
  category: InstrumentCategory;
}

/**
 * Thrown for non-finite / non-positive / out-of-domain values in any of
 * `positionSize`'s own numeric inputs (balance, riskPercent, stopLossPips,
 * lotStep, minLots, maxLots). Problems with `instrumentPrice` or
 * `quoteToUsdRate` surface as `InvalidPipValueInputError` from the
 * pip-value kernel instead.
 */
export class InvalidSizingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSizingInputError";
  }
}

const DEFAULT_LOT_STEP = 0.01;
const DEFAULT_MIN_LOTS = 0.01;
const DEFAULT_MAX_LOTS = 100;

/**
 * Compute a risk-based lot size for a single position.
 *
 * Intended risk is `balance × riskPercent%`. Ideal lot size is
 * `intendedRisk / (stopLossPips × pipValuePerLotUsd)`, where
 * `pipValuePerLotUsd` comes from `pipValueInUsd` — so the caller must supply
 * `instrumentPrice` (inverse) or `quoteToUsdRate` (cross) when those apply.
 *
 * The ideal size is then capped to `maxLots`, rounded DOWN to `lotStep`
 * (never up — realised risk must not exceed intended risk), and snapped to
 * zero if it falls below `minLots`. The returned `riskAmountUsd` reflects
 * the final lot size, not the ideal one.
 *
 * Input errors fall into two classes: numeric problems with the sizing-
 * layer inputs throw `InvalidSizingInputError`; numeric problems with the
 * market rates consumed by `pipValueInUsd` throw
 * `InvalidPipValueInputError` from that module, unchanged.
 */
export function positionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    accountBalanceUsd,
    riskPercent,
    stopLossPips,
    instrument,
    instrumentPrice,
    quoteToUsdRate,
    lotStep = DEFAULT_LOT_STEP,
    minLots = DEFAULT_MIN_LOTS,
    maxLots = DEFAULT_MAX_LOTS,
  } = input;

  assertFinitePositive("accountBalanceUsd", accountBalanceUsd);
  assertFinitePositive("riskPercent", riskPercent);
  assertFinitePositive("stopLossPips", stopLossPips);
  assertFinitePositive("lotStep", lotStep);
  assertFiniteNonNegative("minLots", minLots);
  assertFinitePositive("maxLots", maxLots);

  if (riskPercent > 100) {
    throw new InvalidSizingInputError(
      `riskPercent must be <= 100, got ${riskPercent}`,
    );
  }
  if (maxLots < minLots) {
    throw new InvalidSizingInputError(
      `maxLots (${maxLots}) must be >= minLots (${minLots})`,
    );
  }

  const { pipValueUsd: pipValuePerLotUsd, category } = pipValueInUsd({
    instrument,
    ...(instrumentPrice !== undefined ? { instrumentPrice } : {}),
    ...(quoteToUsdRate !== undefined ? { quoteToUsdRate } : {}),
  });

  const intendedRiskUsd = accountBalanceUsd * (riskPercent / 100);
  const idealLots = intendedRiskUsd / (stopLossPips * pipValuePerLotUsd);

  const cappedLots = Math.min(idealLots, maxLots);
  const roundedLots = roundDownToStep(cappedLots, lotStep);
  const lots = roundedLots < minLots ? 0 : roundedLots;

  const units = lots * instrument.contractSize;
  const pipValueUsd = pipValuePerLotUsd * lots;
  const riskAmountUsd = pipValueUsd * stopLossPips;

  return {
    lots,
    units,
    pipValueUsd,
    intendedRiskUsd,
    riskAmountUsd,
    category,
  };
}

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new InvalidSizingInputError(`${name} must be a finite number, got ${value}`);
  }
  if (value <= 0) {
    throw new InvalidSizingInputError(`${name} must be > 0, got ${value}`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new InvalidSizingInputError(`${name} must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new InvalidSizingInputError(`${name} must be >= 0, got ${value}`);
  }
}

/**
 * Round `value` DOWN to the nearest multiple of `step`, with a small
 * tolerance to avoid floating-point artefacts dropping an increment
 * (e.g. 0.30000000000000004 → 0.29 when it should stay at 0.30).
 */
function roundDownToStep(value: number, step: number): number {
  const epsilon = step * 1e-9;
  const steps = Math.floor((value + epsilon) / step);
  const raw = steps * step;
  // Normalise trailing float noise to step precision.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const factor = 10 ** decimals;
  return Math.round(raw * factor) / factor;
}
