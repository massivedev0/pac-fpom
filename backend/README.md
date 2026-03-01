# FPOM Rewards Backend (MVP)

A simple backend for issuing FPOM rewards after a completed round

## Implemented in this step

- Fastify API
- Prisma + SQLite
- Server-side score recomputation
- Limit of max 2 successful claims per address
- Two verification modes: `wallet_signature` (default) and `address_only`
- MVP anti-abuse checks for IP, fingerprint, and risk score
- In-process payout worker
- `PAYOUT_DRY_RUN=true` by default (no real on-chain transfer)
- Audit log table in DB for claim verification and payout events
- CLI log viewer for readable audit logs

## Quick start

```bash
cd backend
cp .env.example .env
npm install
npx prisma db push
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

## Tests

```bash
cd backend
npm test
```

Test run clears local tables in configured `DATABASE_URL` before each test.

Current coverage includes:

- Happy path claim and dry-run payout
- Address limit of 2 successful claims
- Signature requirement for `wallet_signature`
- Rejection for non-winning run
- Audit log creation for claim lifecycle

## Readable logs from DB

```bash
cd backend
npm run logs
npm run logs -- --limit 100
npm run logs -- --event CLAIM_PREPARED
npm run logs -- --address AU12...
npm run logs -- --claim cmm8...
npm run logs -- --json
```

## Environment variables

See `.env.example`.

Main ones:

- `DATABASE_URL`
- `PAYOUT_DRY_RUN`
- `MAX_CLAIMS_PER_ADDRESS`
- `IP_CLAIMS_PER_DAY_LIMIT`
- `MASSA_REWARD_WALLET_PK`
- `LOG_LEVEL`
- `PRETTY_LOGS`

## Next step

- Real FPOM on-chain transfer instead of dry-run
- Signature verification for `wallet_signature` via massa-web3
- Frontend integration with rewards API
