export const SCORE_VALUES = {
  PELLET: 350,
  POWER_PELLET: 1500,
  ENEMY_BASE: 2500,
  ENEMY_COMBO_STEP: 1000,
  ROUND_CLEAR_BONUS: 12000,
} as const;

export const SCORE_CAPS = {
  MAX_PELLETS: 233,
  MAX_POWER_PELLETS: 5,
  MAX_ENEMIES_EATEN: 200,
} as const;

export type RunSummary = {
  won: boolean;
  durationMs: number;
  pelletsEaten: number;
  powerPelletsEaten: number;
  enemiesEaten: number;
  finalScoreClient: number;
};

export type ScoringSessionEvent = {
  type?: unknown;
  payload?: unknown;
};

/**
 * Restricts numeric value to a closed range
 *
 * @param {number} value Raw numeric value
 * @param {number} min Inclusive lower bound
 * @param {number} max Inclusive upper bound
 * @returns {number} Clamped numeric value
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Sanitizes client run summary before server-side scoring
 *
 * @param {RunSummary} input Client-provided run summary
 * @returns {RunSummary} Normalized run summary
 */
export function normalizeRunSummary(input: RunSummary): RunSummary {
  return {
    won: Boolean(input.won),
    durationMs: clamp(Math.floor(input.durationMs || 0), 0, 24 * 60 * 60 * 1000),
    pelletsEaten: clamp(Math.floor(input.pelletsEaten || 0), 0, SCORE_CAPS.MAX_PELLETS),
    powerPelletsEaten: clamp(
      Math.floor(input.powerPelletsEaten || 0),
      0,
      SCORE_CAPS.MAX_POWER_PELLETS,
    ),
    enemiesEaten: clamp(Math.floor(input.enemiesEaten || 0), 0, SCORE_CAPS.MAX_ENEMIES_EATEN),
    finalScoreClient: Math.max(0, Math.floor(input.finalScoreClient || 0)),
  };
}

/**
 * Computes authoritative server-side reward score
 *
 * @param {RunSummary} input Client-provided run summary
 * @returns {number} Deterministic server score
 */
export function computeServerScore(input: RunSummary): number {
  const s = normalizeRunSummary(input);
  if (!s.won) {
    return 0;
  }

  const pelletsPart = s.pelletsEaten * SCORE_VALUES.PELLET;
  const powerPart = s.powerPelletsEaten * SCORE_VALUES.POWER_PELLET;
  const enemiesPart = s.enemiesEaten * SCORE_VALUES.ENEMY_BASE;
  const clearBonus = SCORE_VALUES.ROUND_CLEAR_BONUS;

  return pelletsPart + powerPart + enemiesPart + clearBonus;
}

/**
 * Safely converts unknown numeric-like payload value into bounded integer
 *
 * @param {unknown} value Raw unknown value
 * @param {number} min Inclusive lower bound
 * @param {number} max Inclusive upper bound
 * @returns {number} Clamped integer value
 */
function asClampedInt(value: unknown, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(Math.floor(value), min, max);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clamp(Math.floor(parsed), min, max);
    }
  }
  return min;
}

/**
 * Extracts exact score contribution from ordered gameplay telemetry
 *
 * @param {RunSummary} input Client-provided run summary
 * @param {ScoringSessionEvent[]} sessionEvents Ordered session telemetry events
 * @returns {number | null} Exact score when telemetry is usable or `null` when fallback is needed
 */
export function computeTelemetryScore(
  input: RunSummary,
  sessionEvents: ScoringSessionEvent[],
): number | null {
  const s = normalizeRunSummary(input);
  if (!s.won) {
    return 0;
  }
  if (!Array.isArray(sessionEvents) || sessionEvents.length === 0) {
    return null;
  }

  let totalScore = 0;
  let combo = 0;
  let pelletsSeen = 0;
  let powerPelletsSeen = 0;
  let enemiesSeen = 0;
  let clearBonusApplied = false;

  for (const event of sessionEvents) {
    const type = typeof event?.type === "string" ? event.type : "";
    const payload =
      event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};

    if (type === "run_started" || type === "life_lost") {
      combo = 0;
      continue;
    }

    if (type === "pellet_eaten") {
      const pelletsRemaining = Math.max(0, s.pelletsEaten - pelletsSeen);
      const powerPelletsRemaining = Math.max(0, s.powerPelletsEaten - powerPelletsSeen);
      const pelletsAdded = asClampedInt(payload.pellets, 0, pelletsRemaining);
      const powerPelletsAdded = asClampedInt(payload.powerPellets, 0, powerPelletsRemaining);

      pelletsSeen += pelletsAdded;
      powerPelletsSeen += powerPelletsAdded;
      totalScore += pelletsAdded * SCORE_VALUES.PELLET;
      totalScore += powerPelletsAdded * SCORE_VALUES.POWER_PELLET;

      if (powerPelletsAdded > 0) {
        combo = 0;
      }
      continue;
    }

    if (type === "enemy_eaten") {
      if (enemiesSeen >= s.enemiesEaten) {
        continue;
      }

      enemiesSeen += 1;
      combo += 1;
      totalScore += SCORE_VALUES.ENEMY_BASE + combo * SCORE_VALUES.ENEMY_COMBO_STEP;
      continue;
    }

    if (type === "run_won" && !clearBonusApplied) {
      clearBonusApplied = true;
      totalScore += SCORE_VALUES.ROUND_CLEAR_BONUS;
    }
  }

  if (
    pelletsSeen !== s.pelletsEaten ||
    powerPelletsSeen !== s.powerPelletsEaten ||
    enemiesSeen !== s.enemiesEaten ||
    !clearBonusApplied
  ) {
    return null;
  }

  return totalScore;
}
