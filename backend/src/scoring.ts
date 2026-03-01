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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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

// MVP formula: conservative and deterministic server-side score calculation.
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
