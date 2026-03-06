/**
 * Renders full game frame (maze, actors, FX, HUD and mode banner)
 *
 * @param {{
 *   ctx: CanvasRenderingContext2D;
 *   state: any;
 *   images: Record<string, HTMLImageElement>;
 *   baseWidth: number;
 *   baseHeight: number;
 *   tile: number;
 *   mazeRows: number;
 *   mazeCols: number;
 *   mazeWidth: number;
 *   mazeHeight: number;
 *   mazeOffsetX: number;
 *   mazeOffsetY: number;
 * }} input Render context
 */
export function renderScene(input) {
  const {
    ctx,
    state,
    images,
    baseWidth,
    baseHeight,
    tile,
    mazeRows,
    mazeCols,
    mazeWidth,
    mazeHeight,
    mazeOffsetX,
    mazeOffsetY,
  } = input;

  ctx.clearRect(0, 0, baseWidth, baseHeight);

  const bg = ctx.createLinearGradient(0, 0, baseWidth, baseHeight);
  bg.addColorStop(0, "#260f31");
  bg.addColorStop(1, "#3d1731");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, baseWidth, baseHeight);

  drawMazeBackground(ctx, mazeRows, mazeWidth, mazeHeight, mazeOffsetX, mazeOffsetY, tile);
  drawWalls(ctx, state, mazeRows, mazeCols, tile, mazeOffsetX, mazeOffsetY);
  drawPellets(ctx, state, mazeOffsetX, mazeOffsetY, tile);

  for (const enemy of state.enemies) {
    drawEnemy(ctx, state, enemy, images);
  }

  if (state.player) {
    drawPlayer(ctx, state, images);
  }

  drawEffects(ctx, state, images);
  drawHud(ctx, state, baseWidth, baseHeight);
  drawModeBanner(ctx, state, baseWidth, baseHeight);
}

/**
 * Draws maze backdrop and scanline accents
 */
function drawMazeBackground(ctx, mazeRows, mazeWidth, mazeHeight, mazeOffsetX, mazeOffsetY, tile) {
  const gradient = ctx.createLinearGradient(0, mazeOffsetY, 0, mazeOffsetY + mazeHeight);
  gradient.addColorStop(0, "#170f29");
  gradient.addColorStop(1, "#29173b");
  ctx.fillStyle = gradient;
  ctx.fillRect(mazeOffsetX, mazeOffsetY, mazeWidth, mazeHeight);

  ctx.save();
  ctx.globalAlpha = 0.1;
  for (let row = 0; row < mazeRows; row += 1) {
    const y = mazeOffsetY + row * tile;
    ctx.fillStyle = row % 2 === 0 ? "#ffd7a0" : "#ffffff";
    ctx.fillRect(mazeOffsetX, y, mazeWidth, 2);
  }
  ctx.restore();
}

/**
 * Draws wall tiles from maze matrix
 */
function drawWalls(ctx, state, mazeRows, mazeCols, tile, mazeOffsetX, mazeOffsetY) {
  for (let row = 0; row < mazeRows; row += 1) {
    for (let col = 0; col < mazeCols; col += 1) {
      if (state.maze[row][col] !== "#") continue;
      const x = mazeOffsetX + col * tile;
      const y = mazeOffsetY + row * tile;

      const wallGradient = ctx.createLinearGradient(x, y, x + tile, y + tile);
      wallGradient.addColorStop(0, "#2e6df7");
      wallGradient.addColorStop(1, "#51e8ff");
      ctx.fillStyle = wallGradient;
      ctx.fillRect(x + 2, y + 2, tile - 4, tile - 4);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 3, y + 3, tile - 6, tile - 6);
    }
  }
}

/**
 * Draws regular and power pellets
 */
function drawPellets(ctx, state, mazeOffsetX, mazeOffsetY, tile) {
  for (const pellet of state.pellets) {
    if (pellet.eaten) continue;
    const centerX = mazeOffsetX + pellet.col * tile + tile / 2;
    const centerY = mazeOffsetY + pellet.row * tile + tile / 2;
    const pulse = 0.75 + Math.sin(state.elapsed * 5 + pellet.col) * 0.2;

    ctx.beginPath();
    ctx.arc(centerX, centerY, pellet.power ? 7 * pulse : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = pellet.power ? "#ff6f6f" : "#ffd773";
    ctx.fill();
  }
}

/**
 * Applies sprite transform based on movement direction
 */
function applyDirectionalTransform(ctx, dir) {
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

/**
 * Draws player sprite and power glow effect
 */
function drawPlayer(ctx, state, images) {
  const p = state.player;
  const facing = p.dir === "left" ? Math.PI : p.dir === "up" ? -Math.PI / 2 : p.dir === "down" ? Math.PI / 2 : 0;
  const mouth = 0.24 + Math.abs(Math.sin(p.mouthPhase)) * 0.2;

  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, p.r + 2, facing + mouth, facing - mouth, false);
  ctx.closePath();
  ctx.clip();

  const glow = state.powerTimer > 0 ? 8 : 3;
  ctx.shadowColor = state.powerTimer > 0 ? "#ff4444" : "#fff3b0";
  ctx.shadowBlur = glow;
  applyDirectionalTransform(ctx, p.dir);
  ctx.drawImage(images.fpom, -(p.r + 4), -(p.r + 4), (p.r + 4) * 2, (p.r + 4) * 2);
  ctx.restore();

  if (state.powerTimer > 0) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r + 5 + Math.sin(state.elapsed * 10) * 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 70, 70, 0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * Draws enemy sprite and frightened aura
 */
function drawEnemy(ctx, state, enemy, images) {
  if (enemy.respawnTimer > 0) {
    return;
  }

  const size = enemy.r * 2.3;
  ctx.save();
  ctx.translate(enemy.x, enemy.y);

  if (state.powerTimer > 0) {
    const blink = Math.sin(enemy.blink * 16) > 0 ? 0.55 : 0.25;
    ctx.fillStyle = `rgba(20, 120, 255, ${blink})`;
    ctx.beginPath();
    ctx.arc(0, 0, enemy.r + 6, 0, Math.PI * 2);
    ctx.fill();
  }

  const img = images[enemy.type];
  if (img.complete) {
    applyDirectionalTransform(ctx, enemy.dir);
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

/**
 * Draws active sprite shard effects
 */
function drawEffects(ctx, state, images) {
  for (const effect of state.effects) {
    const alpha = Math.max(0, Math.min(1, effect.life / effect.maxLife));
    const img = images[effect.spriteKey];

    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.rotate(effect.rotation);
    ctx.globalAlpha = alpha;

    if (img?.complete) {
      ctx.drawImage(
        img,
        effect.srcX,
        effect.srcY,
        effect.srcSize,
        effect.srcSize,
        -effect.size / 2,
        -effect.size / 2,
        effect.size,
        effect.size,
      );
    } else {
      ctx.fillStyle = "rgba(255, 120, 120, 0.85)";
      ctx.fillRect(-effect.size / 2, -effect.size / 2, effect.size, effect.size);
    }

    ctx.restore();
  }
}

/**
 * Draws score, lives and pause overlay
 */
function drawHud(ctx, state, baseWidth, baseHeight) {
  ctx.fillStyle = "#fff7e0";
  ctx.font = '16px "Press Start 2P", monospace';
  ctx.fillText(`Score ${state.score}`, 22, 28);
  ctx.fillText(`Lives ${state.lives}`, 22, 54);

  if (state.powerTimer > 0) {
    ctx.fillStyle = "#ff9d9d";
    ctx.fillText(`HUNT ${state.powerTimer.toFixed(1)}s`, baseWidth - 290, 28);
  }

  if (state.paused && state.mode === "playing") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, baseWidth, baseHeight);
    ctx.fillStyle = "#fff";
    ctx.font = '22px "Bungee", sans-serif';
    ctx.fillText("PAUSED", baseWidth / 2 - 78, baseHeight / 2);
  }
}

/**
 * Draws title, game over or win banner
 */
function drawModeBanner(ctx, state, baseWidth, baseHeight) {
  if (state.mode === "playing") {
    return;
  }

  const cardW = 760;
  const cardH = 280;
  const x = (baseWidth - cardW) / 2;
  const y = (baseHeight - cardH) / 2;

  ctx.fillStyle = "rgba(9, 6, 25, 0.7)";
  ctx.fillRect(0, 0, baseWidth, baseHeight);

  ctx.fillStyle = "rgba(255, 245, 225, 0.95)";
  ctx.fillRect(x, y, cardW, cardH);
  ctx.strokeStyle = "#ff4f34";
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 2, y + 2, cardW - 4, cardH - 4);

  let title = "FPOM Meme Hunt";
  if (state.mode === "gameover") title = "Game Over";
  if (state.mode === "won") title = "FPOM Wins";

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
