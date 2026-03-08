# FPOM Rewards Backend (MVP)

A simple backend for issuing FPOM rewards after a completed round

## Implemented in this step

- Fastify API
- Prisma + SQLite
- Server-side score recomputation
- Limit of max 2 successful claims per address
- Two verification modes: `address_only` (default) and legacy `wallet_signature`
- MVP anti-abuse checks for IP, fingerprint, and risk score
- Risk score includes session telemetry density (`session_events`) to detect suspicious runs
- X profile format validation (`https://x.com/account`) and limit of 2 paid claims per profile
- In-process payout worker
- `PAYOUT_DRY_RUN=true` by default, but real on-chain FPOM transfer is supported when disabled
- Manual review guardrails for oversized payout and daily payout volume
- Audit log table in DB for claim verification and payout events
- Slack webhook notifications for payout and manual review events
- Low-balance alert for payout wallet with 24h cooldown
- Failed payout alert details include classified reason and current payout-wallet balances
- Startup recovery resumes persisted `QUEUED` and `CONFIRMED` payouts from SQLite after backend restart
- Secure approve/reject links for manual review in Slack notifications
- CLI log viewer with fixed-width columns and colors

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
- `GET /public/config`

## Admin endpoints

- `GET /admin/review/:claimId?action=approve|reject&token=...`
- `GET /admin/payouts?token=...`
- `GET /admin/payouts/:claimId?action=retry&token=...`

## Tests

```bash
cd backend
npm test
```

`npm test` now uses an isolated SQLite database at `backend/prisma/rewards.test.db`.
It does not touch the working `DATABASE_URL`.

Optional override:

```bash
cd backend
TEST_DATABASE_URL="file:/absolute/path/to/rewards.test.db" npm test
```

Current coverage includes:

- Happy path claim and dry-run payout
- Happy path claim and real payout path through mocked on-chain sender
- Pending on-chain payout reconciliation through `GET /claim/:claimId`
- Low-balance alert cooldown
- Startup payout recovery after backend restart
- Default claim flow without wallet signature prompt
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

## Admin links from CLI

```bash
cd backend
npm run admin:links
npm run admin:links -- --claim cmm8...
npm run admin:links -- --claim cmm8... --json
```

The command reads `ADMIN_REVIEW_BASE_URL` and `ADMIN_REVIEW_SECRET` from backend env and prints:

- tokenized `/admin/payouts` URL
- for a specific claim: `approve`, `reject`, and `retry payout` URLs

## Environment variables

See `.env.example`.

Main ones:

- `DATABASE_URL`
- `CORS_ALLOWED_ORIGINS`
- `PAYOUT_DRY_RUN`
- `MASSA_REWARD_WALLET_PK`
- `MASSA_ACCOUNT_SECRET_KEY`
- `MASSA_WALLET_PK`
- `MASSA_RPC_URL`
- `MASSA_OPERATION_WAIT`
- `MASSA_OPERATION_TIMEOUT_MS`
- `MASSA_OPERATION_POLL_INTERVAL_MS`
- `NOTIFY_BALANCE_BELOW`
- `MAX_SINGLE_PAYOUT_AMOUNT`
- `MAX_PAYOUTS_PER_DAY`
- `X_PROMO_TWEET`
- `ADMIN_REVIEW_BASE_URL`
- `ADMIN_REVIEW_SECRET`
- `MAX_CLAIMS_PER_ADDRESS`
- `MAX_CLAIMS_PER_X_PROFILE`
- `IP_CLAIMS_PER_DAY_LIMIT`
- `SLACK_WEBHOOK_URL`
- `LOG_LEVEL`
- `PRETTY_LOGS`

## Restart behavior

- Claim state, payout jobs, audit logs, and manual-review decisions are persisted in SQLite
- On startup the backend resumes `QUEUED` payouts and rechecks `CONFIRMED` payouts with stored `txHash`
- `PAID` and `REJECTED` claims stay terminal across restarts
- Admin payout list page shows recent non-terminal payout jobs and generated retry links for retryable claims

## Next step

- Optional signature verification for legacy `wallet_signature` via massa-web3
