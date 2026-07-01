/**
 * Typed IPC surface between the isolated renderer and the Electron main
 * process (M4 slice 2).
 *
 * This module is pure and framework-free (no electron, no DOM) so it can be the
 * *single source of truth* shared by three places that must agree byte-for-byte:
 * the main-side handlers (`src/main/ipc/replayBridge.ts`), the preload bridge
 * (`src/preload/index.ts`), and the renderer that calls `window.hindsight`.
 *
 * ## Structural validation vs. domain validation (deliberate split)
 *
 * The `validate*` functions check only that a payload arriving over IPC is
 * **well-formed at the wire level** — the right object shape, string where a
 * string is required, a *finite* number where a number is required — and throw
 * {@link InvalidIpcPayloadError} otherwise. They do **not** enforce domain
 * rules (symbol in the catalog, `speed > 0`, `startMs < endMs`, timeframe a
 * whole number of seconds). Those stay owned by the kernels the bridge calls
 * (`toCatalogSymbol` → `UnknownInstrumentError`, `createReplaySession` →
 * `InvalidSessionInputError`, the clock → `InvalidClockInputError`) and
 * propagate unchanged, so the layer that actually rejected a value is never
 * hidden. The contract's job is to stop a malformed/hostile message before it
 * reaches a kernel; the kernel's job is to judge the value.
 */

import type { Bar } from "./types.js";

/**
 * The replay IPC channel names. Namespaced under `replay:` so they never
 * collide with channels a future feature (broker, journal) adds.
 */
export const REPLAY_CHANNELS = {
  /** Create/replace the active session. Payload {@link CreateSessionRequest}. */
  createSession: "replay:createSession",
  /** Start playback. No payload. */
  play: "replay:play",
  /** Pause playback. No payload. */
  pause: "replay:pause",
  /** Advance the cursor to now (no-op while paused). No payload. */
  tick: "replay:tick",
  /** Change replay speed. Payload {@link SetSpeedRequest}. */
  setSpeed: "replay:setSpeed",
  /** Nudge the cursor by a delta and pause. Payload {@link StepRequest}. */
  step: "replay:step",
  /** Jump the cursor to an absolute time and pause. Payload {@link ScrubToRequest}. */
  scrubTo: "replay:scrubTo",
  /** Switch the chart timeframe, preserving the cursor. Payload {@link SetTimeframeRequest}. */
  setTimeframe: "replay:setTimeframe",
  /** Read the cursor-clipped visible bars. No payload; returns `Bar[]`. */
  getVisibleBars: "replay:getVisibleBars",
} as const;

/** Union of the replay channel string literals. */
export type ReplayChannel = (typeof REPLAY_CHANNELS)[keyof typeof REPLAY_CHANNELS];

/** Payload for {@link REPLAY_CHANNELS.createSession}. */
export interface CreateSessionRequest {
  /** Instrument symbol; validated against the catalog on the main side. */
  symbol: string;
  /** Session lower bound, inclusive (UTC epoch ms). */
  startMs: number;
  /** Session upper bound, inclusive (UTC epoch ms). */
  endMs: number;
  /** Chart timeframe in ms (e.g. 60_000 for M1). */
  timeframeMs: number;
  /** Optional replay speed multiplier; defaults to 1 on the main side. */
  speed?: number;
}

/** Payload for {@link REPLAY_CHANNELS.setSpeed}. */
export interface SetSpeedRequest {
  /** Replay speed multiplier. */
  speed: number;
}

/** Payload for {@link REPLAY_CHANNELS.step}. */
export interface StepRequest {
  /** Cursor nudge in ms (positive = forward). */
  deltaMs: number;
}

/** Payload for {@link REPLAY_CHANNELS.scrubTo}. */
export interface ScrubToRequest {
  /** Absolute cursor target (UTC epoch ms). */
  targetMs: number;
}

/** Payload for {@link REPLAY_CHANNELS.setTimeframe}. */
export interface SetTimeframeRequest {
  /** New chart timeframe in ms. */
  timeframeMs: number;
}

/**
 * Serialisable view of the replay session returned to the renderer by every
 * command. A flat projection of `ReplaySession` (clock bounds/cursor/speed/
 * status lifted to the top level) — no anchor internals, safe to send over IPC.
 */
export interface SessionSnapshot {
  /** The session's instrument symbol. */
  symbol: string;
  /** Current chart timeframe in ms. */
  timeframeMs: number;
  /** Session lower bound, inclusive (UTC epoch ms). */
  startMs: number;
  /** Session upper bound, inclusive (UTC epoch ms). */
  endMs: number;
  /** Current replay cursor (UTC epoch ms; may be fractional while playing). */
  cursorMs: number;
  /** Current replay speed multiplier. */
  speed: number;
  /** Whether the clock is advancing. */
  status: "paused" | "playing";
}

/**
 * The replay half of the renderer-facing API. Implemented by the preload
 * bridge (each method is an `ipcRenderer.invoke`) and consumed by the renderer.
 * Every command resolves to the resulting {@link SessionSnapshot}, except
 * {@link ReplayBridgeApi.getVisibleBars} which resolves to the visible bars.
 */
export interface ReplayBridgeApi {
  /** @see REPLAY_CHANNELS.createSession */
  createSession(req: CreateSessionRequest): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.play */
  play(): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.pause */
  pause(): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.tick */
  tick(): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.setSpeed */
  setSpeed(req: SetSpeedRequest): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.step */
  step(req: StepRequest): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.scrubTo */
  scrubTo(req: ScrubToRequest): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.setTimeframe */
  setTimeframe(req: SetTimeframeRequest): Promise<SessionSnapshot>;
  /** @see REPLAY_CHANNELS.getVisibleBars */
  getVisibleBars(): Promise<Bar[]>;
}

/** Shape exposed on `window.hindsight` by the preload bridge. */
export interface HindsightApi {
  /** Marker proving the preload bridge is present. */
  readonly ready: true;
  /** The replay control + read surface. */
  readonly replay: ReplayBridgeApi;
}

/**
 * Thrown when an IPC payload is malformed at the wire level (wrong shape, wrong
 * primitive type, or a non-finite number). Carries the {@link ReplayChannel} it
 * arrived on and, where applicable, the offending `field`, so callers and
 * breaking tests can route without re-parsing the message. Distinct from the
 * kernels' domain errors, which mean "well-formed but not a legal value".
 */
export class InvalidIpcPayloadError extends Error {
  /** The channel whose payload was rejected. */
  readonly channel: ReplayChannel;
  /** The offending field, when the failure is attributable to one. */
  readonly field?: string;

  constructor(message: string, args: { channel: ReplayChannel; field?: string }) {
    super(message);
    this.name = "InvalidIpcPayloadError";
    this.channel = args.channel;
    if (args.field !== undefined) this.field = args.field;
  }
}

/** Validate a {@link REPLAY_CHANNELS.createSession} payload. */
export function validateCreateSessionRequest(raw: unknown): CreateSessionRequest {
  const obj = asObject(raw, REPLAY_CHANNELS.createSession);
  const symbol = requireString(obj["symbol"], "symbol", REPLAY_CHANNELS.createSession);
  const startMs = requireFiniteNumber(obj["startMs"], "startMs", REPLAY_CHANNELS.createSession);
  const endMs = requireFiniteNumber(obj["endMs"], "endMs", REPLAY_CHANNELS.createSession);
  const timeframeMs = requireFiniteNumber(
    obj["timeframeMs"],
    "timeframeMs",
    REPLAY_CHANNELS.createSession,
  );
  const req: CreateSessionRequest = { symbol, startMs, endMs, timeframeMs };
  if (obj["speed"] !== undefined) {
    req.speed = requireFiniteNumber(obj["speed"], "speed", REPLAY_CHANNELS.createSession);
  }
  return req;
}

/** Validate a {@link REPLAY_CHANNELS.setSpeed} payload. */
export function validateSetSpeedRequest(raw: unknown): SetSpeedRequest {
  const obj = asObject(raw, REPLAY_CHANNELS.setSpeed);
  return { speed: requireFiniteNumber(obj["speed"], "speed", REPLAY_CHANNELS.setSpeed) };
}

/** Validate a {@link REPLAY_CHANNELS.step} payload. */
export function validateStepRequest(raw: unknown): StepRequest {
  const obj = asObject(raw, REPLAY_CHANNELS.step);
  return { deltaMs: requireFiniteNumber(obj["deltaMs"], "deltaMs", REPLAY_CHANNELS.step) };
}

/** Validate a {@link REPLAY_CHANNELS.scrubTo} payload. */
export function validateScrubToRequest(raw: unknown): ScrubToRequest {
  const obj = asObject(raw, REPLAY_CHANNELS.scrubTo);
  return { targetMs: requireFiniteNumber(obj["targetMs"], "targetMs", REPLAY_CHANNELS.scrubTo) };
}

/** Validate a {@link REPLAY_CHANNELS.setTimeframe} payload. */
export function validateSetTimeframeRequest(raw: unknown): SetTimeframeRequest {
  const obj = asObject(raw, REPLAY_CHANNELS.setTimeframe);
  return {
    timeframeMs: requireFiniteNumber(
      obj["timeframeMs"],
      "timeframeMs",
      REPLAY_CHANNELS.setTimeframe,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals — structural guards.
// ─────────────────────────────────────────────────────────────────────────

function asObject(raw: unknown, channel: ReplayChannel): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidIpcPayloadError(
      `${channel}: payload must be an object, got ${describe(raw)}`,
      { channel },
    );
  }
  return raw as Record<string, unknown>;
}

function requireString(value: unknown, field: string, channel: ReplayChannel): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidIpcPayloadError(
      `${channel}: '${field}' must be a non-empty string, got ${describe(value)}`,
      { channel, field },
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string, channel: ReplayChannel): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidIpcPayloadError(
      `${channel}: '${field}' must be a finite number, got ${describe(value)}`,
      { channel, field },
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
