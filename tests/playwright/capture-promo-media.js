const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const OUTPUT_DIR = path.resolve("output/playwright/fpom-promo");
const FRAMES_DIR = path.join(OUTPUT_DIR, "smooth-frames");
const STILLS_DIR = path.join(OUTPUT_DIR, "stills");
const VIEWPORT = { width: 960, height: 640 };
const FPS = 30;
const DURATION_SECONDS = 10;
const TOTAL_FRAMES = FPS * DURATION_SECONDS;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function stagePromoScene(page) {
  await page.evaluate(() => {
    const game = window.__fpom_game;
    if (!game?.state) {
      throw new Error("Game state is not available");
    }

    const state = game.state;
    const center = (col, row) => ({
      x: 32 + col * 32 + 16,
      y: 16 + row * 32 + 16,
    });

    state.mode = "playing";
    state.paused = false;
    state.score = 4200;
    state.lives = 3;
    state.powerTimer = 12;
    state.combo = 0;
    state.effects = [];
    state.elapsed = 0;
    state.roundResetTimer = 0;

    Object.assign(state.player, center(2, 4), {
      dir: "right",
      desiredDir: "right",
      alive: true,
      mouthPhase: 0,
      speed: 96,
    });

    const stagedEnemies = [
      { type: "shiba", col: 10, row: 4, dir: "left", respawnTimer: 0, speed: 44 },
      { type: "pepe", col: 18, row: 4, dir: "left", respawnTimer: 0, speed: 44 },
      { type: "doge", col: 24, row: 4, dir: "left", respawnTimer: 0, speed: 44 },
      { type: "doge", col: 1, row: 1, dir: "right", respawnTimer: 20, speed: 44 },
      { type: "shiba", col: 1, row: 2, dir: "right", respawnTimer: 20, speed: 44 },
      { type: "pepe", col: 1, row: 3, dir: "right", respawnTimer: 20, speed: 44 },
    ];

    stagedEnemies.forEach((enemyConfig, index) => {
      Object.assign(state.enemies[index], center(enemyConfig.col, enemyConfig.row), {
        type: enemyConfig.type,
        dir: enemyConfig.dir,
        respawnTimer: enemyConfig.respawnTimer,
        blink: 0,
        speed: enemyConfig.speed,
      });
    });
  });
}

async function captureCanvasPng(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || typeof canvas.toDataURL !== "function") {
      return null;
    }
    const dataUrl = canvas.toDataURL("image/png");
    const marker = dataUrl.indexOf(",");
    return marker === -1 ? null : dataUrl.slice(marker + 1);
  });

  if (!base64) {
    throw new Error("Failed to read canvas PNG data");
  }

  return Buffer.from(base64, "base64");
}

async function main() {
  ensureDir(OUTPUT_DIR);
  resetDir(FRAMES_DIR);
  resetDir(STILLS_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader"],
  });

  const page = await browser.newPage({ viewport: VIEWPORT });

  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
  });

  await page.goto("http://127.0.0.1:4177", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.click("#start-btn");
  await page.waitForTimeout(150);

  await stagePromoScene(page);

  const stillFrames = new Map([
    [50, "promo-shot-1.png"],
    [140, "promo-shot-2.png"],
    [205, "promo-shot-3.png"],
  ]);

  for (let frame = 0; frame < TOTAL_FRAMES; frame += 1) {
    await page.evaluate(async (fps) => {
      await window.advanceTime(1000 / fps);
    }, FPS);

    const png = await captureCanvasPng(page);
    const frameName = `frame-${String(frame).padStart(4, "0")}.png`;
    const framePath = path.join(FRAMES_DIR, frameName);
    fs.writeFileSync(framePath, png);

    const stillName = stillFrames.get(frame);
    if (stillName) {
      fs.copyFileSync(framePath, path.join(STILLS_DIR, stillName));
    }
  }

  const finalState = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (finalState) {
    fs.writeFileSync(path.join(OUTPUT_DIR, "final-state.json"), finalState);
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
