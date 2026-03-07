/**
 * Core game viewport dimensions
 * @readonly
 */
export const BASE_WIDTH = 960;
export const BASE_HEIGHT = 640;

/**
 * Fixed maze tile size in pixels
 * @readonly
 */
export const TILE = 32;

/**
 * Deterministic fixed-step update delta (seconds)
 * @readonly
 */
export const FIXED_DT = 1 / 60;

/**
 * Reward/claim client defaults
 * @readonly
 */
export const REWARDS_API_TIMEOUT_MS = 11_000;
export const DEFAULT_LOCAL_API = "http://127.0.0.1:8787";
export const DEFAULT_DEBUG_WIN_SCORE = 106_050;
export const DEFAULT_X_PROMO_TWEET = "https://x.com/massalabs";
export const SESSION_EVENTS_BATCH_SIZE = 64;
export const SESSION_EVENTS_BUFFER_LIMIT = 1200;
export const SESSION_RETRY_DELAY_MS = 2500;

/**
 * Wallet/claim flow defaults
 * @readonly
 */
export const WALLET_CONNECT_TIMEOUT_MS = 9000;
export const CLAIM_VERIFICATION_MODE = "address_only";

/**
 * Score values tuned for roughly 100k points per full clear run
 * @readonly
 */
export const SCORE_VALUES = Object.freeze({
  PELLET: 350,
  POWER_PELLET: 1500,
  ENEMY_BASE: 2500,
  ENEMY_COMBO_STEP: 1000,
  ROUND_CLEAR_BONUS: 12000,
});

/**
 * Direction vectors in tile-space
 * @readonly
 */
export const DIRS = Object.freeze({
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
});

/**
 * Base maze template (# wall, . pellet, * power pellet, space path).
 * @readonly
 */
export const MAZE_TEMPLATE = Object.freeze([
  "############################",
  "#............##............#",
  "#.####.#####....#####.####.#",
  "#*####.#####.##.#####.####*#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.#####.##.#####.######",
  "######.##..........##.######",
  "######.##..........##.######",
  "######.##..........##.######",
  "#..........#....#..........#",
  "#.####.#####.##.#####.####.#",
  "#*..##................##..*#",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
]);

/**
 * Enemy spawn sequence
 * @readonly
 */
export const ENEMY_TYPES = Object.freeze(["doge", "shiba", "pepe", "doge", "shiba", "pepe"]);
