# pac-fpom

FPOM Meme Hunt is a lightweight Pac-Man-style browser game built for FPOM promotion.

## Project Layout

- `index.html` - app entry page
- `src/` - runtime client code (`game.js`, `styles.css`)
- `assets/` - game images and logos
- `backend/` - FPOM rewards API (Fastify + Prisma + SQLite)
- `tests/playwright/actions/` - Playwright client action payloads
- `logo-and-info/` - source brand assets and campaign text

## Local Run

```bash
npm run serve
# open http://localhost:4177
```

## Smoke Check (Playwright client)

```bash
npm run test:smoke
```

Note: `test:smoke` expects `$CODEX_HOME/skills/develop-web-game/scripts/web_game_playwright_client.js`.

## Rewards API for claim flow

After round win the game can submit reward claims to backend API

- Local default API: `http://127.0.0.1:8787`
- Override with query param: `?rewardsApi=https://your-backend.example`
- Override with global variable before `game.js`: `window.__FPOM_REWARDS_API__ = "https://your-backend.example"`
- Promo tweet URL is loaded from backend `GET /public/config` (`X_PROMO_TWEET` in backend env)
- Optional promo tweet override: `?promoTweet=https://x.com/account/status/123`
- Debug shortcut button `Victory` is visible only on localhost with `?dev=1`
- Claim form requires Massa address (or wallet connect) and X profile URL in format `https://x.com/account`

Backend quick run:

```bash
cd backend
npm install
npx prisma db push
npm run dev
```
