// Compaction math for dsh-vcc, dependency-free so it is testable outside a Cordis runtime.
// See lib/tuning-plugin.js for the patch-addressable entry that exposes these defaults.

/** Keys the basic backend's resolveConfig understands (strict whitelist). */
export const ENGINE_CONFIG_KEYS = new Set([
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
])

// Fill band per route: the buffer only has to survive the request that crosses the trigger, so
// its floor is a 32th of the window (128k -> 4000, 32k -> 1000) and both ends stop at
// SUMMARY_CAP — a longer summary is never written, so buffer past the cap buys nothing.
const HEADROOM_FLOOR = 0.03125
const HEADROOM_CEILING = 0.25
export const SUMMARY_CAP = 16_384

export const DEFAULTS = {
  thresholdRatio: 0.85,
  retainTokens: 16_000,
  // Sized at HEADROOM_FLOOR of 32k: the smallest window a route we have never seen could
  // plausibly have. Anything larger makes pressure non-positive and the engine rejects the route.
  headroomTokens: 1_000,
  auto: true,
}

/**
 * Buffer for one route, as a fraction of its own window rather than an absolute: the stock
 * 65536 puts the trigger near a fifth of the window and rejects any window under ~114k when the
 * output reservation is 32k.
 * @param window - adapter context window for the route.
 * @param reserved - output tokens one request reserves on that route.
 * @param ratio - fill target the trigger is capped by.
 * @returns positive headroom that keeps pressure positive.
 */
export function headroomFor(window, reserved, ratio = DEFAULTS.thresholdRatio) {
  const budget = window - reserved
  const want = budget - Math.floor(window * ratio)
  const band = Math.min(
    Math.max(want, Math.min(Math.floor(window * HEADROOM_FLOOR), SUMMARY_CAP)),
    Math.max(Math.min(Math.floor(window * HEADROOM_CEILING), SUMMARY_CAP), 1),
  )
  // A budget that cannot afford a buffer inside the band keeps pressure positive instead of
  // throwing TargetPressureConfigError; fill then lands under the band, which is the honest best.
  return budget - band > 0 ? band : Math.max(budget - 1, 1)
}

/** Exact provider/model override, so a route never inherits another route's buffer. */
export function routePolicy(provider, model, window, reserved, ratio = DEFAULTS.thresholdRatio) {
  const headroomTokens = headroomFor(window, reserved, ratio)
  return Object.freeze({ provider, model, headroomTokens, maxTokens: Math.min(headroomTokens, SUMMARY_CAP) })
}

/**
 * Compose the config handed to the basic backend: tuning defaults under the row's own config,
 * with keys the backend does not understand (the `vcc` sub-object) dropped.
 * @param rowConfig - config declared on the preset's `dsh-vcc` row.
 * @param knobs - resolved tuning knobs.
 * @returns a plain config object for `super(ctx, ...)`.
 */
export function engineConfig(rowConfig = {}, knobs = DEFAULTS) {
  const merged = { ...knobs, ...rowConfig }
  const composed = {}
  for (const key of ENGINE_CONFIG_KEYS) if (merged[key] !== undefined) composed[key] = merged[key]
  return composed
}
