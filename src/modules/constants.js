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
export const REWARDS_API_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCAL_API = "http://127.0.0.1:8787";
export const DEFAULT_PRODUCTION_API = "https://pac-backend.fpom.app";
export const DEFAULT_DEBUG_WIN_SCORE = 106_050;
export const DEFAULT_X_PROMO_TWEET = "https://x.com/massalabs";
export const SESSION_EVENTS_BATCH_SIZE = 64;
export const SESSION_EVENTS_BUFFER_LIMIT = 1200;
export const SESSION_RETRY_DELAY_MS = 2500;

/**
 * Public FPOM links used in README and title-screen CTA footer
 * @readonly
 */
export const PROJECT_LINKS = Object.freeze({
  GIT: "https://github.com/massivedev0/pac-fpom/",
  X: "https://x.com/PepeOnMassaFake",
  DUSA: "https://app.dusa.io/pools/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib/AS12U4TZfNK7qoLyEERBBRDMu8nm5MKoRzPXDXans4v9wdATZedz9/100/V2",
  EAGLEFI: "https://www.eaglefi.io/token/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
  DUSER_PUMP: "https://duser-pump.netlify.app/trade/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib",
  X_INTRO_POST: "https://x.com/PepeOnMassaFake/status/1935283435217592782",
  X_SUMMARY_POST: "https://x.com/PepeOnMassaFake/status/1935284341887684740",
});

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
 * Default full-size arcade layout and spawn data
 * @readonly
 */
export const DEFAULT_GAME_VARIANT = Object.freeze({
  id: "default",
  mazeTemplate: Object.freeze([
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
  ]),
  forcePowerPellet: Object.freeze({ row: 13, col: 14 }),
  playerSpawn: Object.freeze({ row: 13, col: 14, dir: "left" }),
  enemyRespawn: Object.freeze({ row: 9, col: 14 }),
  enemyTypes: Object.freeze(["doge", "shiba", "pepe", "doge", "shiba", "pepe"]),
  enemySpawnPoints: Object.freeze([
    Object.freeze({ col: 13, row: 8, dir: "left" }),
    Object.freeze({ col: 14, row: 8, dir: "right" }),
    Object.freeze({ col: 12, row: 9, dir: "up" }),
    Object.freeze({ col: 15, row: 9, dir: "down" }),
    Object.freeze({ col: 11, row: 10, dir: "right" }),
    Object.freeze({ col: 16, row: 10, dir: "left" }),
  ]),
});

/**
 * Small local-only map for `?dev=2` quick reward-flow testing
 * @readonly
 */
export const DEV_TEST_GAME_VARIANT = Object.freeze({
  id: "dev_test",
  mazeTemplate: Object.freeze([
    "#############",
    "#.....#.....#",
    "#.###.#.###.#",
    "#*..........#",
    "#.###.#.###.#",
    "#...#...#...#",
    "#.###.#.###.#",
    "#...........#",
    "#.###.#.###.#",
    "#.....#....*#",
    "#############",
  ]),
  forcePowerPellet: null,
  playerSpawn: Object.freeze({ row: 7, col: 1, dir: "right" }),
  enemyRespawn: Object.freeze({ row: 3, col: 6 }),
  enemyTypes: Object.freeze(["doge", "pepe"]),
  enemySpawnPoints: Object.freeze([
    Object.freeze({ col: 6, row: 3, dir: "left" }),
    Object.freeze({ col: 7, row: 3, dir: "right" }),
  ]),
});
