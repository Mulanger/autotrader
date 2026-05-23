# Polywhale Autotrader

Local copy-trading workbench for selected Polywhale leaderboard wallets.

Current state:

- Demo trading only: starts with `$100` cash and uses `$10` per copied buy.
- Risk rule: only copies watched BUY trades priced at `75c` or lower.
- Repeat-entry rule: only the first copied trade from a given wallet on a given market is copied.
- Live whale stream + polling from `https://whaleserver-production.up.railway.app`.
- Real trading page is intentionally disabled until an execution adapter is added and explicitly armed.
- Every observed trade is logged with a copied/skipped decision.

## Run

```powershell
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend API/WebSocket: `http://127.0.0.1:4101`

## Railway

This repo is configured as one Railway web service:

```text
Build: npm run build
Start: npm start
Healthcheck: /api/health
```

`npm start` serves the built React dashboard from `dist/`, keeps `/api/*` on the same origin, and exposes dashboard updates through `/events`.

For durable demo state, add Railway Postgres to the service so Railway injects `DATABASE_URL`. Without `DATABASE_URL`, the app still runs but clearly reports `Storage memory only`, and demo history resets when the process restarts. With Postgres connected, the app writes normalized audit tables for observed trades, copy decisions, demo positions, trader profiles, and the demo account.

## Candidate Tracker

The `$1k-$10k` candidate trader tracker is isolated behind `CANDIDATE_TRACKER_ENABLED=true`. When enabled with `DATABASE_URL`, it polls Polymarket Data API directly, stores qualifying trades in `candidate_*` tables, backfills newly seen wallets for 30 days, resolves markets through Gamma, and serves the dashboard Candidates tab from `/api/candidates/leaderboard`.

## Environment

Optional:

- `PORT`: backend port, defaults to `4101`.
- `HOST`: server bind host, defaults to `0.0.0.0`.
- `POLYWHALE_API_BASE_URL`: defaults to `https://whaleserver-production.up.railway.app`.
- `POLYMARKET_DATA_API_URL`: defaults to `https://data-api.polymarket.com`.
- `POLYMARKET_GAMMA_URL`: defaults to `https://gamma-api.polymarket.com`.
- `POLL_INTERVAL_MS`: defaults to `20000`.
- `RESOLUTION_POLL_INTERVAL_MS`: defaults to `60000`.
- `DEMO_MAX_ENTRY_PRICE_CENTS`: defaults to `75`.
- `CANDIDATE_TRACKER_ENABLED`: enables the isolated candidate tracker, defaults to `false`.
- `CANDIDATE_MIN_USD`: defaults to `1000`.
- `CANDIDATE_MAX_USD`: exclusive maximum, defaults to `10000`.
- `CANDIDATE_BACKFILL_DAYS`: defaults to `30`.
- `CANDIDATE_POLL_INTERVAL_MS`: defaults to `30000`.
- `DATABASE_URL`: Postgres connection string used to persist demo state and trade history.

Real-money trading is not implemented in this scaffold. Do not put wallet private keys into this app until a real execution adapter, signing flow, and risk gates are reviewed.
