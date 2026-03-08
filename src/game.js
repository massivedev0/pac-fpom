import {
  BASE_HEIGHT,
  BASE_WIDTH,
  DEFAULT_DEBUG_WIN_SCORE,
  DEFAULT_X_PROMO_TWEET,
  DIRS,
  ENEMY_TYPES,
  FIXED_DT,
  MAZE_TEMPLATE,
  SCORE_VALUES,
  TILE,
} from "./modules/constants.js";
import { renderScene } from "./modules/render-system.js";
import { isValidMassaAddress } from "./modules/rewards-helpers.js";
import { discoverWalletCandidates, getCandidateAccounts, resetWalletCandidate } from "./modules/wallet-service.js";
import { createWalletUiController } from "./modules/wallet-ui.js";
import { createRewardsController } from "./modules/rewards-controller.js";
import { createOverlayUiController } from "./modules/overlay-ui.js";

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const startButton = document.getElementById("start-btn");
const menuOverlay = document.getElementById("menu-overlay");
const topWalletButton = document.getElementById("top-wallet-btn");
const walletModal = document.getElementById("wallet-modal");
const walletModalClose = document.getElementById("wallet-modal-close");
const walletModalSubtitle = document.getElementById("wallet-modal-subtitle");
const walletOptions = document.getElementById("wallet-options");
const rewardPanel = document.getElementById("reward-panel");
const rewardSummary = document.getElementById("reward-summary");
const promoTweetLink = document.getElementById("promo-tweet-link");
const xProfileInput = document.getElementById("x-profile");
const walletStatus = document.getElementById("wallet-status");
const claimButton = document.getElementById("claim-btn");
const claimStatus = document.getElementById("claim-status");
const devWinButton = document.getElementById("dev-win-btn");

const MAZE_ROWS = MAZE_TEMPLATE.length;
const MAZE_COLS = MAZE_TEMPLATE[0].length;
const MAZE_WIDTH = MAZE_COLS * TILE;
const MAZE_HEIGHT = MAZE_ROWS * TILE;
const MAZE_OFFSET_X = Math.floor((BASE_WIDTH - MAZE_WIDTH) / 2);
const MAZE_OFFSET_Y = Math.floor((BASE_HEIGHT - MAZE_HEIGHT) / 2);

/**
 * Central mutable runtime state of the game session
 * Kept in one object to simplify serialization and UI debug snapshots
 */
const STATE = {
  mode: "title",
  score: 0,
  lives: 3,
  combo: 0,
  elapsed: 0,
  paused: false,
  powerTimer: 0,
  pelletsLeft: 0,
  inputDir: "left",
  maze: MAZE_TEMPLATE.map((row) => row.split("")),
  pellets: [],
  player: null,
  enemies: [],
  effects: [],
  roundResetTimer: 0,
  runStats: {
    startedAtMs: 0,
    pelletsEaten: 0,
    powerPelletsEaten: 0,
    enemiesEaten: 0,
  },
  rewards: {
    apiBase: "",
    promoTweetUrl: "",
    promoOverrideLocked: false,
    promoConfigFetchTried: false,
    sessionId: null,
    sessionRetryAtMs: 0,
    nextEventSeq: 0,
    eventBuffer: [],
    eventOverflow: false,
    eventFlushInFlight: false,
    claimInFlight: false,
    claimStatusText: "",
    walletProviders: [],
    connectedAddress: "",
    walletProviderName: "",
    walletProvider: null,
    walletAccount: null,
    walletModalInFlight: false,
    activeClaimId: null,
  },
};

const images = {
  fpom: loadImage("../assets/fpom/fpom-logo-transparent.png"),
  doge: loadImage("../assets/memes/doge.png"),
  shiba: loadImage("../assets/memes/shiba.png"),
  pepe: loadImage("../assets/memes/pepe.png"),
};

const keysPressed = new Set();
let audioCtx = null;
let animationFrame = null;
let lastTs = 0;
let accumulator = 0;

// ------------------------------------------------------------
// Bootstrap / environment helpers
// ------------------------------------------------------------

/**
 * Loads image asset relative to current module URL
 *
 * @param {string} src Relative asset path
 * @returns {HTMLImageElement}
 */
function loadImage(src) {
  const img = new Image();
  // Resolve URLs relative to this module file (works on GitHub Pages subpaths).
  img.src = new URL(src, import.meta.url).href;
  return img;
}

/**
 * Applies promo tweet URL to local state and reward panel link
 *
 * @param {string} url Candidate URL from config/query/backend
 */
function applyPromoTweetUrl(url) {
  const normalized = (url || "").trim() || DEFAULT_X_PROMO_TWEET;
  STATE.rewards.promoTweetUrl = normalized;

  if (promoTweetLink) {
    promoTweetLink.href = normalized;
    promoTweetLink.textContent = normalized;
  }
}

/**
 * Checks whether local debug tools are enabled
 */
function isDebugToolsEnabled() {
  const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const isDevParamEnabled = new URLSearchParams(window.location.search).get("dev") === "1";
  return isLocalHost && isDevParamEnabled;
}

// ------------------------------------------------------------
// Rewards panel + wallet connection UI
// ------------------------------------------------------------

/**
 * Updates claim status text in state and UI
 */
function setClaimStatus(text) {
  STATE.rewards.claimStatusText = text;
  if (claimStatus) {
    claimStatus.textContent = text;
  }
}

/**
 * Enables or disables reward claim controls
 */
function setClaimControlsDisabled(disabled) {
  if (claimButton) {
    claimButton.disabled = disabled;
  }
  if (xProfileInput) {
    xProfileInput.disabled = disabled;
  }
}

/**
 * Updates wallet status text in reward panel
 */
function setWalletStatus(text) {
  if (walletStatus) {
    walletStatus.textContent = text;
  }
}

/**
 * Wallet modal and wallet-status controller
 */
const walletUi = createWalletUiController({
  rewardsState: STATE.rewards,
  dom: {
    topWalletButton,
    walletModal,
    walletModalClose,
    walletModalSubtitle,
    walletOptions,
  },
  setClaimStatus,
  setWalletStatus,
  isValidMassaAddress,
  discoverWalletCandidates,
  getCandidateAccounts,
  resetWalletCandidate,
});

/**
 * Rewards/session/claim controller
 */
const rewardsController = createRewardsController({
  rewardsState: STATE.rewards,
  runStats: STATE.runStats,
  setClaimStatus,
  setClaimControlsDisabled,
  applyPromoTweetUrl,
  getScore: () => STATE.score,
  getMode: () => STATE.mode,
});

/**
 * Overlay/menu controller
 */
const overlayUi = createOverlayUiController({
  menuOverlay,
  startButton,
  rewardPanel,
  rewardSummary,
  setTopWalletButtonVisible: (visible) => {
    walletUi.setTopWalletButtonVisible(visible);
  },
  onRewardsShown: () => {
    rewardsController.maybeSyncPromoTweetFromBackend();
  },
});

/**
 * Forces win state for local debug flow
 */
function triggerDebugVictory() {
  if (!isDebugToolsEnabled()) {
    return;
  }
  if (STATE.mode !== "playing") {
    return;
  }

  for (const pellet of STATE.pellets) {
    pellet.eaten = true;
  }
  STATE.pelletsLeft = 0;
  STATE.runStats.pelletsEaten = 233;
  STATE.runStats.powerPelletsEaten = 5;
  if (STATE.runStats.enemiesEaten < 2) {
    STATE.runStats.enemiesEaten = 2;
  }
  STATE.score = Math.max(STATE.score, DEFAULT_DEBUG_WIN_SCORE);
  STATE.mode = "won";
  rewardsController.queueSessionEvent("run_won", {
    source: "debug_button",
    finalScore: STATE.score,
    durationMs: rewardsController.getRunElapsedMs(),
  });
  setClaimStatus("Debug victory enabled: submit reward claim");
  overlayUi.showOverlay({
    mode: STATE.mode,
    title: "FPOM Wins",
    buttonLabel: "Play Again",
    score: STATE.score,
  });
}

// ------------------------------------------------------------
// World initialization and entity factories
// ------------------------------------------------------------

/**
 * Builds maze pellets and remaining pellet counter from template
 */
function initMaze() {
  STATE.pellets = [];
  STATE.pelletsLeft = 0;

  for (let row = 0; row < MAZE_ROWS; row += 1) {
    for (let col = 0; col < MAZE_COLS; col += 1) {
      const ch = STATE.maze[row][col];
      if (ch === "." || ch === "*") {
        const forcePower = row === 13 && col === 14;
        STATE.pellets.push({
          row,
          col,
          power: ch === "*" || forcePower,
          eaten: false,
        });
        STATE.pelletsLeft += 1;
      }
    }
  }
}

/**
 * Returns pixel center for a given tile coordinate
 */
function tileCenter(col, row) {
  return {
    x: MAZE_OFFSET_X + col * TILE + TILE / 2,
    y: MAZE_OFFSET_Y + row * TILE + TILE / 2,
  };
}

/**
 * Creates initial player entity
 */
function createPlayer() {
  const spawn = tileCenter(14, 13);
  return {
    x: spawn.x,
    y: spawn.y,
    r: 13,
    speed: 128,
    dir: "left",
    desiredDir: "left",
    mouthPhase: 0,
    alive: true,
  };
}

/**
 * Creates enemy entity by type and spawn index
 */
function createEnemy(type, idx) {
  const spawnPoints = [
    { col: 13, row: 8, dir: "left" },
    { col: 14, row: 8, dir: "right" },
    { col: 12, row: 9, dir: "up" },
    { col: 15, row: 9, dir: "down" },
    { col: 11, row: 10, dir: "right" },
    { col: 16, row: 10, dir: "left" },
  ];
  const point = spawnPoints[idx] ?? spawnPoints[0];
  const spawn = tileCenter(point.col, point.row);
  return {
    type,
    x: spawn.x,
    y: spawn.y,
    r: 12,
    speed: 98 + idx * 3,
    dir: point.dir,
    vulnerable: false,
    respawnTimer: 0,
    blink: 0,
  };
}

/**
 * Resets player and enemy entities to spawn state
 */
function resetEntities() {
  STATE.player = createPlayer();
  STATE.enemies = ENEMY_TYPES.map((type, i) => createEnemy(type, i));
  STATE.powerTimer = 0;
  STATE.combo = 0;
  STATE.roundResetTimer = 0;
}

/**
 * Starts a fresh run and resets score and runtime flags
 */
function startNewGame() {
  STATE.mode = "playing";
  STATE.score = 0;
  STATE.lives = 3;
  STATE.elapsed = 0;
  STATE.paused = false;
  STATE.effects = [];
  STATE.runStats.startedAtMs = performance.now();
  STATE.runStats.pelletsEaten = 0;
  STATE.runStats.powerPelletsEaten = 0;
  STATE.runStats.enemiesEaten = 0;
  rewardsController.resetRunState();
  STATE.maze = MAZE_TEMPLATE.map((row) => row.split(""));
  initMaze();
  resetEntities();
  rewardsController.queueSessionEvent("run_started", {
    lives: STATE.lives,
    pelletsLeft: STATE.pelletsLeft,
  });
  setClaimStatus("");
  walletUi.closeWalletModal();
  overlayUi.hideOverlay();
  ensureAudioContext();
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  playTone(460, 0.09, "triangle", 0.04);
}

/**
 * Resets entities after losing a life while keeping score
 */
function resetRound() {
  resetEntities();
}

// ------------------------------------------------------------
// Audio helpers
// ------------------------------------------------------------

/**
 * Initializes shared audio context lazily
 */
function ensureAudioContext() {
  if (audioCtx) {
    return;
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return;
  }
  audioCtx = new AudioContext();
}

/**
 * Plays short procedural retro tone
 */
function playTone(freq, duration = 0.08, type = "square", volume = 0.05) {
  if (!audioCtx || audioCtx.state === "suspended") {
    return;
  }
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + duration);
}

// ------------------------------------------------------------
// Movement, collision and gameplay update loop
// ------------------------------------------------------------

/**
 * Converts world pixel coordinate to maze tile coordinate
 */
function worldToTile(x, y) {
  return {
    col: Math.floor((x - MAZE_OFFSET_X) / TILE),
    row: Math.floor((y - MAZE_OFFSET_Y) / TILE),
  };
}

/**
 * Checks whether tile coordinate is blocked by wall
 */
function tileIsWall(col, row) {
  if (col < 0 || row < 0 || col >= MAZE_COLS || row >= MAZE_ROWS) {
    return true;
  }
  return STATE.maze[row][col] === "#";
}

/**
 * Checks whether entity is close to tile center point
 */
function isNearCenter(entity, tolerance = 2.1) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  return (
    Math.abs(center.x - entity.x) <= tolerance &&
    Math.abs(center.y - entity.y) <= tolerance
  );
}

/**
 * Checks whether entity can move in direction without hitting walls
 */
function canMove(entity, dir) {
  const vec = DIRS[dir];
  const step = 4;
  const nx = entity.x + vec.x * step;
  const ny = entity.y + vec.y * step;
  const r = Math.max(5, entity.r - 4);

  const checks = [
    worldToTile(nx - r, ny - r),
    worldToTile(nx + r, ny - r),
    worldToTile(nx - r, ny + r),
    worldToTile(nx + r, ny + r),
  ];

  return checks.every((tile) => !tileIsWall(tile.col, tile.row));
}

/**
 * Snaps entity position to nearest tile center
 */
function snapToGrid(entity) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  entity.x = center.x;
  entity.y = center.y;
}

/**
 * Tries to switch player to desired direction
 */
function tryApplyDesiredDirection(forceSnap = false) {
  const player = STATE.player;
  if (!forceSnap && player.desiredDir === player.dir) {
    return false;
  }
  if (!canMove(player, player.desiredDir)) {
    return false;
  }
  if (forceSnap || isNearCenter(player, 3.2)) {
    snapToGrid(player);
    player.dir = player.desiredDir;
    return true;
  }
  return false;
}

/**
 * Updates player movement and desired direction application
 */
function updatePlayer(dt) {
  const player = STATE.player;
  if (!player.alive) return;
  if (player.desiredDir === oppositeDirection(player.dir) && canMove(player, player.desiredDir)) {
    player.dir = player.desiredDir;
  } else {
    tryApplyDesiredDirection(false);
  }

  if (!canMove(player, player.dir)) {
    snapToGrid(player);
    const changed = tryApplyDesiredDirection(true);
    if (!changed && !canMove(player, player.dir)) return;
  }

  const vec = DIRS[player.dir];
  player.x += vec.x * player.speed * dt;
  player.y += vec.y * player.speed * dt;
  player.mouthPhase += dt * 12;
}

/**
 * Returns opposite direction key
 */
function oppositeDirection(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "up") return "down";
  return "up";
}

/**
 * Updates enemy AI movement and direction changes
 */
function updateEnemy(enemy, dt) {
  if (enemy.respawnTimer > 0) {
    enemy.respawnTimer -= dt;
    return;
  }

  const chooseDirection = () => {
    const dirs = Object.keys(DIRS).filter((dir) => canMove(enemy, dir));
    const noBacktrack = dirs.filter((dir) => dir !== oppositeDirection(enemy.dir));
    const options = noBacktrack.length > 0 ? noBacktrack : dirs;
    if (options.length === 0) return;

    if (STATE.powerTimer > 0) {
      enemy.dir = options[Math.floor(Math.random() * options.length)];
    } else {
      if (Math.random() < 0.28) {
        enemy.dir = options[Math.floor(Math.random() * options.length)];
        return;
      }
      const player = STATE.player;
      let bestDir = options[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const dir of options) {
        const vec = DIRS[dir];
        const tx = enemy.x + vec.x * TILE * 1.2;
        const ty = enemy.y + vec.y * TILE * 1.2;
        const dist = (player.x - tx) ** 2 + (player.y - ty) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          bestDir = dir;
        }
      }
      enemy.dir = bestDir;
    }
  };

  if (isNearCenter(enemy, 0.45)) {
    snapToGrid(enemy);
    chooseDirection();
  } else if (!canMove(enemy, enemy.dir)) {
    snapToGrid(enemy);
    chooseDirection();
  }

  const speed = STATE.powerTimer > 0 ? enemy.speed * 0.72 : enemy.speed;
  if (canMove(enemy, enemy.dir)) {
    const vec = DIRS[enemy.dir];
    enemy.x += vec.x * speed * dt;
    enemy.y += vec.y * speed * dt;
  }
  enemy.blink += dt;
}

/**
 * Spawns sprite shard particles for hit effects
 */
function spawnShatterEffect(x, y, radius, spriteKey, amount = 18) {
  const image = images[spriteKey];
  const imgW = image?.naturalWidth || 64;
  const imgH = image?.naturalHeight || 64;

  for (let i = 0; i < amount; i += 1) {
    const angle = (Math.PI * 2 * i) / amount + Math.random() * 0.5;
    const speed = 90 + Math.random() * 170;
    const size = 4 + Math.random() * 8;
    const srcSize = Math.max(6, Math.floor((Math.random() * 0.12 + 0.04) * Math.min(imgW, imgH)));
    const life = 0.82 + Math.random() * 0.38;
    STATE.effects.push({
      kind: "shard",
      spriteKey,
      x: x + Math.cos(angle) * (radius * 0.18),
      y: y + Math.sin(angle) * (radius * 0.18),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      size,
      life,
      maxLife: life,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 9,
      srcX: Math.floor(Math.random() * Math.max(1, imgW - srcSize)),
      srcY: Math.floor(Math.random() * Math.max(1, imgH - srcSize)),
      srcSize,
    });
  }
}

/**
 * Advances and prunes active shard effects
 */
function updateEffects(dt) {
  for (const e of STATE.effects) {
    e.life -= dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vy += 260 * dt;
    e.rotation += e.spin * dt;
  }
  STATE.effects = STATE.effects.filter((e) => e.life > 0);
}

/**
 * Handles pellet and power pellet pickup logic
 */
function eatPellets() {
  const player = STATE.player;
  let pelletsEatenThisTick = 0;
  let powerPelletsEatenThisTick = 0;

  for (const pellet of STATE.pellets) {
    if (pellet.eaten) continue;
    const center = tileCenter(pellet.col, pellet.row);
    const hitDist = pellet.power ? 19 : 16;
    if (Math.hypot(player.x - center.x, player.y - center.y) <= hitDist) {
      pellet.eaten = true;
      STATE.pelletsLeft -= 1;
      if (pellet.power) {
        powerPelletsEatenThisTick += 1;
        STATE.runStats.powerPelletsEaten += 1;
        STATE.score += SCORE_VALUES.POWER_PELLET;
        STATE.powerTimer = 8;
        STATE.combo = 0;
        playTone(620, 0.08, "triangle", 0.05);
        playTone(860, 0.11, "triangle", 0.045);
      } else {
        pelletsEatenThisTick += 1;
        STATE.runStats.pelletsEaten += 1;
        STATE.score += SCORE_VALUES.PELLET;
        playTone(250, 0.04, "square", 0.02);
      }
    }
  }

  if (pelletsEatenThisTick > 0 || powerPelletsEatenThisTick > 0) {
    rewardsController.queueSessionEvent("pellet_eaten", {
      pellets: pelletsEatenThisTick,
      powerPellets: powerPelletsEatenThisTick,
      pelletsLeft: STATE.pelletsLeft,
    });
  }

  if (STATE.pelletsLeft <= 0) {
    STATE.score += SCORE_VALUES.ROUND_CLEAR_BONUS;
    STATE.mode = "won";
    rewardsController.queueSessionEvent("run_won", {
      finalScore: STATE.score,
      durationMs: rewardsController.getRunElapsedMs(),
      pelletsEaten: STATE.runStats.pelletsEaten,
      powerPelletsEaten: STATE.runStats.powerPelletsEaten,
      enemiesEaten: STATE.runStats.enemiesEaten,
      telemetryOverflow: STATE.rewards.eventOverflow,
    });
    if (!STATE.rewards.apiBase) {
      setClaimStatus("Rewards API is not configured for this host");
    } else if (isValidMassaAddress(STATE.rewards.connectedAddress || "")) {
      setClaimStatus("Add X profile and claim your FPOM");
    } else {
      setClaimStatus("Connect wallet, add X profile, and claim your FPOM");
    }
    overlayUi.showOverlay({
      mode: STATE.mode,
      title: "FPOM Wins",
      buttonLabel: "Play Again",
      score: STATE.score,
    });
    playTone(840, 0.1, "sawtooth", 0.06);
    playTone(1040, 0.15, "triangle", 0.05);
  }
}

/**
 * Handles collisions between player and enemies
 */
function handleEnemyCollisions() {
  const player = STATE.player;
  if (!player.alive) return;

  for (const enemy of STATE.enemies) {
    if (enemy.respawnTimer > 0) continue;
    const hit = Math.hypot(player.x - enemy.x, player.y - enemy.y) <= player.r + enemy.r - 2;
    if (!hit) continue;

    if (STATE.powerTimer > 0) {
      spawnShatterEffect(enemy.x, enemy.y, enemy.r * 2.2, enemy.type, 14);
      enemy.respawnTimer = 2.8;
      const spawn = tileCenter(14, 9);
      enemy.x = spawn.x;
      enemy.y = spawn.y;
      STATE.runStats.enemiesEaten += 1;
      STATE.combo += 1;
      STATE.score += SCORE_VALUES.ENEMY_BASE + STATE.combo * SCORE_VALUES.ENEMY_COMBO_STEP;
      rewardsController.queueSessionEvent("enemy_eaten", {
        enemyType: enemy.type,
        combo: STATE.combo,
      });
      playTone(700, 0.06, "square", 0.04);
      playTone(920, 0.08, "triangle", 0.035);
    } else {
      spawnShatterEffect(player.x, player.y, player.r * 2.4, "fpom", 24);
      player.alive = false;
      STATE.lives -= 1;
      rewardsController.queueSessionEvent("life_lost", {
        livesLeft: STATE.lives,
      });
      playTone(180, 0.22, "sawtooth", 0.05);
      if (STATE.lives <= 0) {
        STATE.mode = "gameover";
        rewardsController.queueSessionEvent("run_lost", {
          finalScore: STATE.score,
          durationMs: rewardsController.getRunElapsedMs(),
        });
        overlayUi.showOverlay({
          mode: STATE.mode,
          title: "Game Over",
          buttonLabel: "Try Again",
          score: STATE.score,
        });
      } else {
        STATE.roundResetTimer = 0.95;
      }
      return;
    }
  }
}

/**
 * Fixed-step gameplay update
 *
 * @param {number} dt Delta time in seconds
 */
function update(dt) {
  if (STATE.mode !== "playing" || STATE.paused) {
    updateEffects(dt);
    return;
  }

  STATE.elapsed += dt;
  updateEffects(dt);

  if (STATE.roundResetTimer > 0) {
    STATE.roundResetTimer -= dt;
    if (STATE.roundResetTimer <= 0 && STATE.lives > 0) {
      resetRound();
    }
    return;
  }

  if (STATE.powerTimer > 0) {
    STATE.powerTimer = Math.max(0, STATE.powerTimer - dt);
  }

  updatePlayer(dt);
  for (const enemy of STATE.enemies) {
    updateEnemy(enemy, dt);
  }

  eatPellets();
  handleEnemyCollisions();
}

// ------------------------------------------------------------
// Rendering and frame stepping
// ------------------------------------------------------------

/**
 * Renders current frame on game canvas
 */
function render() {
  renderScene({
    ctx,
    state: STATE,
    images,
    baseWidth: BASE_WIDTH,
    baseHeight: BASE_HEIGHT,
    tile: TILE,
    mazeRows: MAZE_ROWS,
    mazeCols: MAZE_COLS,
    mazeWidth: MAZE_WIDTH,
    mazeHeight: MAZE_HEIGHT,
    mazeOffsetX: MAZE_OFFSET_X,
    mazeOffsetY: MAZE_OFFSET_Y,
  });
}

/**
 * RAF loop with fixed timestep accumulator
 */
function gameLoop(ts) {
  if (!lastTs) {
    lastTs = ts;
  }
  let delta = (ts - lastTs) / 1000;
  delta = Math.min(delta, 0.05);
  lastTs = ts;
  accumulator += delta;

  while (accumulator >= FIXED_DT) {
    update(FIXED_DT);
    accumulator -= FIXED_DT;
  }

  render();
  animationFrame = requestAnimationFrame(gameLoop);
}

/**
 * Deterministic stepping hook used by Playwright automation
 *
 * @param {number} ms Virtual milliseconds to advance
 */
function advanceTime(ms) {
  const steps = Math.max(1, Math.round(ms / (FIXED_DT * 1000)));
  for (let i = 0; i < steps; i += 1) {
    update(FIXED_DT);
  }
  render();
}

/**
 * Debug/state serialization used by automated testing tools
 *
 * @returns {string}
 */
function renderGameToText() {
  const player = STATE.player
    ? {
        x: Number(STATE.player.x.toFixed(1)),
        y: Number(STATE.player.y.toFixed(1)),
        r: STATE.player.r,
        dir: STATE.player.dir,
        desiredDir: STATE.player.desiredDir,
      }
    : null;

  const activePellets = STATE.pellets
    .filter((p) => !p.eaten)
    .slice(0, 20)
    .map((p) => ({ row: p.row, col: p.col, power: p.power }));

  const enemies = STATE.enemies.map((e) => ({
    type: e.type,
    x: Number(e.x.toFixed(1)),
    y: Number(e.y.toFixed(1)),
    dir: e.dir,
    active: e.respawnTimer <= 0,
  }));

  return JSON.stringify({
    coordinate_system: "origin top-left; x right; y down; maze tile size 32px",
    mode: STATE.mode,
    paused: STATE.paused,
    score: STATE.score,
    lives: STATE.lives,
    power_timer: Number(STATE.powerTimer.toFixed(2)),
    pellets_left: STATE.pelletsLeft,
    player,
    enemies,
    effects_count: STATE.effects.length,
    round_reset_timer: Number(STATE.roundResetTimer.toFixed(2)),
    sample_active_pellets: activePellets,
  });
}

// ------------------------------------------------------------
// Input / claim actions
// ------------------------------------------------------------

/**
 * Applies directional input to player desired direction
 */
function handleDirectionInput(dir) {
  if (!STATE.player) return;
  if (STATE.player.desiredDir !== dir) {
    rewardsController.queueSessionEvent("input_direction", {
      dir,
    });
  }
  STATE.player.desiredDir = dir;
}

/**
 * Toggles pause mode during active run
 */
function togglePause() {
  if (STATE.mode !== "playing") return;
  STATE.paused = !STATE.paused;
  rewardsController.queueSessionEvent("pause_toggled", {
    paused: STATE.paused,
  });
}

/**
 * Toggles browser fullscreen mode
 */
async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
}

/**
 * Reads reward claim form values from UI
 */
function readClaimForm() {
  const xProfile = xProfileInput ? xProfileInput.value.trim() : "";
  return { xProfile };
}

/**
 * Checks whether target element is text-editable
 */
function isTextInputElement(element) {
  if (!element) {
    return false;
  }
  const tagName = element.tagName ? element.tagName.toUpperCase() : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return Boolean(element.isContentEditable);
}

/**
 * Handles keyboard keydown events for gameplay and UI
 */
function onKeyDown(event) {
  const { code } = event;
  keysPressed.add(code);
  const isTypingTarget = isTextInputElement(event.target);
  const isWalletModalOpen = Boolean(walletModal && !walletModal.hidden);

  if (isWalletModalOpen) {
    if (code === "Escape") {
      walletUi.closeWalletModal();
    }
    return;
  }

  if (code === "Enter" || code === "Space") {
    if (STATE.mode === "title" || STATE.mode === "gameover" || STATE.mode === "won") {
      startNewGame();
      return;
    }
  }

  if (code === "KeyP") {
    togglePause();
    return;
  }

  if (code === "KeyF") {
    if (isTypingTarget) {
      return;
    }
    toggleFullscreen().catch(() => {});
    return;
  }

  if (code === "ArrowLeft" || code === "KeyA") handleDirectionInput("left");
  if (code === "ArrowRight" || code === "KeyD") handleDirectionInput("right");
  if (code === "ArrowUp" || code === "KeyW") handleDirectionInput("up");
  if (code === "ArrowDown" || code === "KeyS") handleDirectionInput("down");
}

/**
 * Handles keyboard keyup events
 */
function onKeyUp(event) {
  keysPressed.delete(event.code);
}

/**
 * Registers DOM and input event listeners
 */
function setupEvents() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  startButton.addEventListener("click", () => startNewGame());
  if (claimButton) {
    claimButton.addEventListener("click", () => {
      rewardsController.submitRewardClaim(readClaimForm()).catch(() => {});
    });
  }
  if (topWalletButton) {
    topWalletButton.addEventListener("click", () => {
      walletUi.openWalletModal().catch(() => {
        setClaimStatus("Failed to open wallet selector");
      });
    });
  }
  if (walletModalClose) {
    walletModalClose.addEventListener("click", () => {
      walletUi.closeWalletModal();
    });
  }
  if (walletModal) {
    walletModal.addEventListener("click", (event) => {
      if (event.target === walletModal) {
        walletUi.closeWalletModal();
      }
    });
  }
  if (devWinButton) {
    devWinButton.addEventListener("click", () => {
      triggerDebugVictory();
    });
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      canvas.style.width = "min(96vw, 960px)";
    }
  });

  menuOverlay.addEventListener("click", () => {
    ensureAudioContext();
    if (audioCtx?.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
  });
}

/**
 * App entry point
 */
function init() {
  rewardsController.applyRuntimeConfig();
  initMaze();
  resetEntities();
  setupEvents();
  if (devWinButton) {
    devWinButton.hidden = !isDebugToolsEnabled();
  }
  if (rewardPanel) {
    rewardPanel.hidden = true;
  }
  walletUi.setTopWalletButtonVisible(true);
  walletUi.updateTopWalletButton();
  walletUi.updateWalletStatusForClaimPanel();
  setClaimControlsDisabled(false);
  if (STATE.rewards.apiBase) {
    setClaimStatus(`Rewards API: ${STATE.rewards.apiBase}`);
  } else {
    setClaimStatus("Rewards API is not configured");
  }
  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;
  window.__fpom_game = { state: STATE, walletUi, rewardsController };
  render();

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = requestAnimationFrame(gameLoop);
}

init();
