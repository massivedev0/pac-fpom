# FPOM Rewards Backend (MVP)

A simple backend for issuing FPOM rewards after a completed round.

## Implemented in this step

- Fastify API.
- Prisma + SQLite.
- Server-side score recomputation.
- Limit: max 2 successful claims per address.
- Two verification modes:
  - `wallet_signature` (default)
  - `address_only`
- MVP anti-abuse: IP/fingerprint/risk-score/manual-review.
- In-process payout worker.
- `PAYOUT_DRY_RUN=true` by default (no real on-chain transfer).

## Quick start

```bash
cd backend
cp .env.example .env
npm install
npm run prisma:migrate
npm run prisma:generate
npm run dev
```

API will be available at `http://localhost:8787`.

## Main endpoints

- `POST /session/start`
- `POST /session/event`
- `POST /claim/prepare`
- `POST /claim/confirm`
- `GET /claim/:claimId`
- `GET /health`

## Example requests

### 1) Start session

```bash
curl -sS -X POST http://localhost:8787/session/start \
  -H 'Content-Type: application/json' \
  -d '{"fingerprint":"demo-device-v1"}'
```

### 2) Prepare claim

```bash
curl -sS -X POST http://localhost:8787/claim/prepare \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId":"SESSION_ID",
    "address":"AU12JW83PvprBFcnwp2rvbPvx3mAVpN7JWra6ML2etf9PKogKfkkx",
    "verificationMode":"address_only",
    "fingerprint":"demo-device-v1",
    "run":{
      "won":true,
      "durationMs":180000,
      "pelletsEaten":233,
      "powerPelletsEaten":5,
      "enemiesEaten":8,
      "finalScoreClient":120000
    }
  }'
```

### 3) Confirm claim

```bash
curl -sS -X POST http://localhost:8787/claim/confirm \
  -H 'Content-Type: application/json' \
  -d '{"claimId":"CLAIM_ID"}'
```

## Environment variables

See `.env.example`.

Main ones:

- `DATABASE_URL`
- `PAYOUT_DRY_RUN`
- `MAX_CLAIMS_PER_ADDRESS`
- `IP_CLAIMS_PER_DAY_LIMIT`
- `MASSA_REWARD_WALLET_PK` (for next step real payout)

## Next step

- Real FPOM on-chain transfer (instead of dry-run).
- Signature verification for `wallet_signature` via massa-web3.
- Frontend integration with this API.
