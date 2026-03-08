# Pac-FPOM: Fake PEPE on Massa Meme Hunt game

FPOM Meme Hunt is a lightweight Pac-Man-style browser game built for FPOM promotion.

## Public Links

- GitHub Pages: [massivedev0.github.io/pac-fpom](https://massivedev0.github.io/pac-fpom/)
- Massa DeWeb native MNS: [pac-fpom.massa](http://pac-fpom.massa/)
- Massa DeWeb mirror 1: [pac-fpom.deweb.half-red.net](https://pac-fpom.deweb.half-red.net)
- Massa DeWeb mirror 2: [pac-fpom.deweb.node-master.fr](https://pac-fpom.deweb.node-master.fr)
- Local DeWeb server variant: [pac-fpom.localhost:8080](http://pac-fpom.localhost:8080/)

## FPOM Links

- X: [PepeOnMassaFake](https://x.com/PepeOnMassaFake)
- Trade on Duser-Pump: [duser-pump.netlify.app](https://duser-pump.netlify.app/trade/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib)
- EagleFi DEX: [eaglefi.io token page](https://www.eaglefi.io/token/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib)
- Dusa DEX: [app.dusa.io pool page](https://app.dusa.io/pools/AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib/AS12U4TZfNK7qoLyEERBBRDMu8nm5MKoRzPXDXans4v9wdATZedz9/100/V2)
- X intro post: [June 2025 intro post](https://x.com/PepeOnMassaFake/status/1935283435217592782)
- X summary post: [June 2025 summary post](https://x.com/PepeOnMassaFake/status/1935284341887684740)

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
- Top-right `Connect Wallet` button opens wallet picker (`Massa Wallet` / `Bearby`) similar to DEX UX
- Before claim confirm, frontend uploads buffered run telemetry to `POST /session/event`

Backend quick run:

```bash
cd backend
npm install
npx prisma db push
npm run dev
```

## What Matters Before Production

- Run the backend behind a reverse proxy and process manager on Ubuntu, not as a raw dev process
- Keep `backend/.env` secrets only on the server and rotate payout keys if they were ever exposed locally
- Back up the SQLite reward database regularly or move to PostgreSQL if traffic grows
- Monitor Slack alerts, payout failures, low-balance warnings, and GitHub Actions deploy status
- Rate-limit public reward endpoints at the edge if claim traffic starts to grow
- Test the game on real iPhone and Android devices, especially orientation lock and touch controls
