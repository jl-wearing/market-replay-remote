/**
 * Position sizing — USD account, USD-quoted instruments (v1).
 *
 * Given an account balance, a risk percentage, a stop-loss distance in pips,
 * and an instrument, compute the lot size that risks at most the intended
 * amount if the stop is hit. Lots are rounded DOWN to `lotStep` so the
 * realised risk never exceeds the intended risk.
 *
 * v1 intentionally supports only USD-quoted instruments so pip value per lot
 * is constant and does not require a current price or a cross rate. Non-USD
 * quotes throw `UnsupportedQuoteCurrencyError` — that scope lands in M1.
 */

import type { InstrumentSpec } from "./instruments.js";

export interface PositionSizeInput {
  accountBalanceUsd: number;
  /** Percentage of account to risk, e.g. 1 for 1 %. Must be in (0, 100]. */
  riskPercent: number;
  /** Distance from entry to stop loss, in pips of the instrument. Must be > 0. */
  stopLossPips: number;
  instrument: InstrumentSpec;
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
}

export class InvalidSizingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSizingInputError";
  }
}

export class UnsupportedQuoteCurrencyError extends Error {
  readonly quoteCurrency: string;
  constructor(quoteCurrency: string) {
    super(
      `Position sizing v1 only supports USD-quoted instruments; got quote currency "${quoteCurrency}". ` +
        `Non-USD quotes (crosses, USD/JPY, etc.) require a current price or cross rate and are planned for M1.`,
    );
    this.name = "UnsupportedQuoteCurrencyError";
    this.quoteCurrency = quoteCurrency;
  }
}

const DEFAULT_LOT_STEP = 0.01;
const DEFAULT_MIN_LOTS = 0.01;
const DEFAULT_MAX_LOTS = 100;

export function positionSize(input: PositionSizeInput): PositionSizeResult {
  const {
    accountBalanceUsd,
    riskPercent,
    stopLossPips,
    instrument,
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

  if (instrument.quoteCurrency !== "USD") {
    throw new UnsupportedQuoteCurrencyError(instrument.quoteCurrency);
  }

  const pipValuePerLotUsd = instrument.pipSize * instrument.contractSize;
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
