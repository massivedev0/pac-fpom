# pac-fpom

FPOM Meme Hunt is a lightweight Pac-Man-style browser game built for FPOM promotion.

## Project Layout

- `index.html` - app entry page
- `src/` - runtime client code (`game.js`, `styles.css`)
- `assets/` - game images and logos
- `tests/playwright/actions/` - Playwright client action payloads
- `logo-and-info/` - source brand assets and campaign text

## Local Run

```bash
npm run serve
# open http://localhost:4174
```

## Smoke Check (Playwright client)

```bash
npm run test:smoke
```

Note: `test:smoke` expects `$CODEX_HOME/skills/develop-web-game/scripts/web_game_playwright_client.js`.
