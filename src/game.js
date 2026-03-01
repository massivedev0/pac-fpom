const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const startButton = document.getElementById("start-btn");
const menuOverlay = document.getElementById("menu-overlay");

const BASE_WIDTH = 960;
const BASE_HEIGHT = 640;
const TILE = 32;
const FIXED_DT = 1 / 60;

const DIRS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const MAZE_TEMPLATE = [
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
];

const MAZE_ROWS = MAZE_TEMPLATE.length;
const MAZE_COLS = MAZE_TEMPLATE[0].length;
const MAZE_WIDTH = MAZE_COLS * TILE;
const MAZE_HEIGHT = MAZE_ROWS * TILE;
const MAZE_OFFSET_X = Math.floor((BASE_WIDTH - MAZE_WIDTH) / 2);
const MAZE_OFFSET_Y = Math.floor((BASE_HEIGHT - MAZE_HEIGHT) / 2);

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
};

const images = {
  fpom: loadImage("../assets/fpom/fpom-logo-transparent.png"),
  doge: loadImage("../assets/memes/doge.png"),
  shiba: loadImage("../assets/memes/shiba.png"),
  pepe: loadImage("../assets/memes/pepe.png"),
};

const enemyTypes = ["doge", "shiba", "pepe", "doge", "shiba", "pepe"];

const keysPressed = new Set();
let audioCtx = null;
let animationFrame = null;
let lastTs = 0;
let accumulator = 0;

function loadImage(src) {
  const img = new Image();
  // Resolve URLs relative to this module file (works on GitHub Pages subpaths).
  img.src = new URL(src, import.meta.url).href;
  return img;
}

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

function tileCenter(col, row) {
  return {
    x: MAZE_OFFSET_X + col * TILE + TILE / 2,
    y: MAZE_OFFSET_Y + row * TILE + TILE / 2,
  };
}

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

function resetEntities() {
  STATE.player = createPlayer();
  STATE.enemies = enemyTypes.map((type, i) => createEnemy(type, i));
  STATE.powerTimer = 0;
  STATE.combo = 0;
  STATE.roundResetTimer = 0;
}

function startNewGame() {
  STATE.mode = "playing";
  STATE.score = 0;
  STATE.lives = 3;
  STATE.elapsed = 0;
  STATE.paused = false;
  STATE.effects = [];
  STATE.maze = MAZE_TEMPLATE.map((row) => row.split(""));
  initMaze();
  resetEntities();
  hideOverlay();
  ensureAudioContext();
  if (audioCtx?.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  playTone(460, 0.09, "triangle", 0.04);
}

function resetRound() {
  resetEntities();
}

function hideOverlay() {
  menuOverlay.style.display = "none";
}

function showOverlay(text, buttonLabel) {
  menuOverlay.style.display = "grid";
  const title = menuOverlay.querySelector("h1");
  const subtitle = menuOverlay.querySelector(".subtitle");
  title.textContent = text;
  subtitle.textContent =
    STATE.mode === "won"
      ? "Delusion-fueled momentum complete. Press start for another run."
      : "FPOM got rugged by memes. Press start to run it back.";
  startButton.textContent = buttonLabel;
}

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

function worldToTile(x, y) {
  return {
    col: Math.floor((x - MAZE_OFFSET_X) / TILE),
    row: Math.floor((y - MAZE_OFFSET_Y) / TILE),
  };
}

function tileIsWall(col, row) {
  if (col < 0 || row < 0 || col >= MAZE_COLS || row >= MAZE_ROWS) {
    return true;
  }
  return STATE.maze[row][col] === "#";
}

function isNearCenter(entity, tolerance = 2.1) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  return (
    Math.abs(center.x - entity.x) <= tolerance &&
    Math.abs(center.y - entity.y) <= tolerance
  );
}

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

function snapToGrid(entity) {
  const tile = worldToTile(entity.x, entity.y);
  const center = tileCenter(tile.col, tile.row);
  entity.x = center.x;
  entity.y = center.y;
}

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

function oppositeDirection(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "up") return "down";
  return "up";
}

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

function eatPellets() {
  const player = STATE.player;
  for (const pellet of STATE.pellets) {
    if (pellet.eaten) continue;
    const center = tileCenter(pellet.col, pellet.row);
    const hitDist = pellet.power ? 19 : 16;
    if (Math.hypot(player.x - center.x, player.y - center.y) <= hitDist) {
      pellet.eaten = true;
      STATE.pelletsLeft -= 1;
      if (pellet.power) {
        STATE.score += 60;
        STATE.powerTimer = 8;
        STATE.combo = 0;
        playTone(620, 0.08, "triangle", 0.05);
        playTone(860, 0.11, "triangle", 0.045);
      } else {
        STATE.score += 12;
        playTone(250, 0.04, "square", 0.02);
      }
    }
  }

  if (STATE.pelletsLeft <= 0) {
    STATE.mode = "won";
    showOverlay("FPOM Wins", "Play Again");
    playTone(840, 0.1, "sawtooth", 0.06);
    playTone(1040, 0.15, "triangle", 0.05);
  }
}

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
      STATE.combo += 1;
      STATE.score += 150 + STATE.combo * 50;
      playTone(700, 0.06, "square", 0.04);
      playTone(920, 0.08, "triangle", 0.035);
    } else {
      spawnShatterEffect(player.x, player.y, player.r * 2.4, "fpom", 24);
      player.alive = false;
      STATE.lives -= 1;
      playTone(180, 0.22, "sawtooth", 0.05);
      if (STATE.lives <= 0) {
        STATE.mode = "gameover";
        showOverlay("Game Over", "Try Again");
      } else {
        STATE.roundResetTimer = 0.95;
      }
      return;
    }
  }
}

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

function drawMazeBackground() {
  const gradient = ctx.createLinearGradient(0, MAZE_OFFSET_Y, 0, MAZE_OFFSET_Y + MAZE_HEIGHT);
  gradient.addColorStop(0, "#170f29");
  gradient.addColorStop(1, "#29173b");
  ctx.fillStyle = gradient;
  ctx.fillRect(MAZE_OFFSET_X, MAZE_OFFSET_Y, MAZE_WIDTH, MAZE_HEIGHT);

  ctx.save();
  ctx.globalAlpha = 0.1;
  for (let row = 0; row < MAZE_ROWS; row += 1) {
    const y = MAZE_OFFSET_Y + row * TILE;
    ctx.fillStyle = row % 2 === 0 ? "#ffd7a0" : "#ffffff";
    ctx.fillRect(MAZE_OFFSET_X, y, MAZE_WIDTH, 2);
  }
  ctx.restore();
}

function drawWalls() {
  for (let row = 0; row < MAZE_ROWS; row += 1) {
    for (let col = 0; col < MAZE_COLS; col += 1) {
      if (STATE.maze[row][col] !== "#") continue;
      const x = MAZE_OFFSET_X + col * TILE;
      const y = MAZE_OFFSET_Y + row * TILE;

      const wallGradient = ctx.createLinearGradient(x, y, x + TILE, y + TILE);
      wallGradient.addColorStop(0, "#2e6df7");
      wallGradient.addColorStop(1, "#51e8ff");
      ctx.fillStyle = wallGradient;
      ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 3, y + 3, TILE - 6, TILE - 6);
    }
  }
}

function drawPellets() {
  for (const pellet of STATE.pellets) {
    if (pellet.eaten) continue;
    const c = tileCenter(pellet.col, pellet.row);
    const pulse = 0.75 + Math.sin(STATE.elapsed * 5 + pellet.col) * 0.2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, pellet.power ? 7 * pulse : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = pellet.power ? "#ff6f6f" : "#ffd773";
    ctx.fill();
  }
}

function applyDirectionalTransform(dir) {
  if (dir === "left") {
    ctx.scale(-1, 1);
    return;
  }
  if (dir === "down") {
    ctx.rotate(Math.PI / 2);
    return;
  }
  if (dir === "up") {
    ctx.rotate(Math.PI / 2);
    ctx.scale(-1, 1);
  }
}

function drawPlayer() {
  const p = STATE.player;
  const facing = p.dir === "left" ? Math.PI : p.dir === "up" ? -Math.PI / 2 : p.dir === "down" ? Math.PI / 2 : 0;
  const mouth = 0.24 + Math.abs(Math.sin(p.mouthPhase)) * 0.2;

  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, p.r + 2, facing + mouth, facing - mouth, false);
  ctx.closePath();
  ctx.clip();

  const glow = STATE.powerTimer > 0 ? 8 : 3;
  ctx.shadowColor = STATE.powerTimer > 0 ? "#ff4444" : "#fff3b0";
  ctx.shadowBlur = glow;
  applyDirectionalTransform(p.dir);
  ctx.drawImage(images.fpom, -(p.r + 4), -(p.r + 4), (p.r + 4) * 2, (p.r + 4) * 2);

  ctx.restore();

  if (STATE.powerTimer > 0) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 5 + Math.sin(STATE.elapsed * 10) * 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawEnemy(enemy) {
  if (enemy.respawnTimer > 0) {
    return;
  }

  const size = enemy.r * 2.3;
  ctx.save();
  ctx.translate(enemy.x, enemy.y);

  if (STATE.powerTimer > 0) {
    const blink = Math.sin(enemy.blink * 16) > 0 ? 0.55 : 0.25;
    ctx.fillStyle = `rgba(20, 120, 255, ${blink})`;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.r + 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const img = images[enemy.type];
  if (img.complete) {
    applyDirectionalTransform(enemy.dir);
    if (enemy.type === "pepe") {
      ctx.beginPath();
      ctx.arc(0, 0, enemy.r + 0.5, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(0, 0, enemy.r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawEffects() {
  for (const e of STATE.effects) {
    const alpha = Math.max(0, Math.min(1, e.life / e.maxLife));
    const img = images[e.spriteKey];
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(e.rotation);
    ctx.globalAlpha = alpha;
    if (img?.complete) {
      ctx.drawImage(
        img,
        e.srcX,
        e.srcY,
        e.srcSize,
        e.srcSize,
        -e.size / 2,
        -e.size / 2,
        e.size,
        e.size,
      );
    } else {
      ctx.fillStyle = "rgba(255, 120, 120, 0.85)";
      ctx.fillRect(-e.size / 2, -e.size / 2, e.size, e.size);
    }
    ctx.restore();
  }
}

function drawHud() {
  ctx.fillStyle = "#fff7e0";
  ctx.font = '16px "Press Start 2P", monospace';
  ctx.fillText(`Score ${STATE.score}`, 22, 28);
  ctx.fillText(`Lives ${STATE.lives}`, 22, 54);

  if (STATE.powerTimer > 0) {
    ctx.fillStyle = "#ff9d9d";
    ctx.fillText(`HUNT ${STATE.powerTimer.toFixed(1)}s`, BASE_WIDTH - 290, 28);
  }

  if (STATE.paused && STATE.mode === "playing") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);
    ctx.fillStyle = "#fff";
    ctx.font = '22px "Bungee", sans-serif';
    ctx.fillText("PAUSED", BASE_WIDTH / 2 - 78, BASE_HEIGHT / 2);
  }
}

function drawModeBanner() {
  if (STATE.mode === "playing") {
    return;
  }

  const cardW = 760;
  const cardH = 280;
  const x = (BASE_WIDTH - cardW) / 2;
  const y = (BASE_HEIGHT - cardH) / 2;

  ctx.fillStyle = "rgba(9, 6, 25, 0.7)";
  ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  ctx.fillStyle = "rgba(255, 245, 225, 0.95)";
  ctx.fillRect(x, y, cardW, cardH);
  ctx.strokeStyle = "#ff4f34";
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 2, y + 2, cardW - 4, cardH - 4);

  let title = "FPOM Meme Hunt";
  if (STATE.mode === "gameover") title = "Game Over";
  if (STATE.mode === "won") title = "FPOM Wins";

  ctx.fillStyle = "#5a1208";
  ctx.font = '44px "Bungee", sans-serif';
  ctx.fillText(title, x + 72, y + 74);

  ctx.fillStyle = "#2f1a15";
  ctx.font = '12px "Press Start 2P", monospace';
  ctx.fillText("No more scams. Gimme a serious fake.", x + 70, y + 112);
  ctx.fillText("Move: WASD / Arrows  |  F: fullscreen  |  P: pause", x + 70, y + 148);
  ctx.fillText("Collect memes. Eat red orb to hunt Doge, Shiba, Pepe.", x + 70, y + 176);
  ctx.fillText("Press Enter / Space or click Start Hunt", x + 70, y + 218);
}

function render() {
  ctx.clearRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  const bg = ctx.createLinearGradient(0, 0, BASE_WIDTH, BASE_HEIGHT);
  bg.addColorStop(0, "#260f31");
  bg.addColorStop(1, "#3d1731");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  drawMazeBackground();
  drawWalls();
  drawPellets();

  for (const enemy of STATE.enemies) {
    drawEnemy(enemy);
  }

  if (STATE.player) {
    drawPlayer();
  }
  drawEffects();

  drawHud();
  drawModeBanner();
}

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

function advanceTime(ms) {
  const steps = Math.max(1, Math.round(ms / (FIXED_DT * 1000)));
  for (let i = 0; i < steps; i += 1) {
    update(FIXED_DT);
  }
  render();
}

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

function handleDirectionInput(dir) {
  if (!STATE.player) return;
  STATE.player.desiredDir = dir;
}

function togglePause() {
  if (STATE.mode !== "playing") return;
  STATE.paused = !STATE.paused;
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
}

function onKeyDown(event) {
  const { code } = event;
  keysPressed.add(code);

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
    toggleFullscreen().catch(() => {});
    return;
  }

  if (code === "ArrowLeft" || code === "KeyA") handleDirectionInput("left");
  if (code === "ArrowRight" || code === "KeyD") handleDirectionInput("right");
  if (code === "ArrowUp" || code === "KeyW") handleDirectionInput("up");
  if (code === "ArrowDown" || code === "KeyS") handleDirectionInput("down");
}

function onKeyUp(event) {
  keysPressed.delete(event.code);
}

function setupEvents() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  startButton.addEventListener("click", () => startNewGame());

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

function init() {
  initMaze();
  resetEntities();
  setupEvents();
  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;
  window.__fpom_game = { state: STATE };
  render();

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
  }
  animationFrame = requestAnimationFrame(gameLoop);
}

init();
