# Polywhale Autotrader

Local copy-trading workbench for selected Polywhale leaderboard wallets.

Current state:

- Demo trading only: starts with `$1,000` cash and uses `$10` per copied buy.
- Risk rule: only copies watched BUY trades priced at `75c` or lower.
- Repeat-entry rule: only the first copied trade from a given wallet on a given market is copied.
- Live whale stream + polling from `https://whaleserver-production.up.railway.app`.
- Real dashboard defaults to dry-run: manual follows, PIN-gated add/remove, and fixed-stake FOK quote audits. Live order submission is available only when Railway explicitly sets live mode and Polymarket signing credentials.
- Watched trades are logged with copied/skipped decisions; unrelated whale rows are kept out of the normal dashboard payload.

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

The `$1k-$10k` candidate trader tracker is isolated behind `CANDIDATE_TRACKER_ENABLED=true`. When enabled with `DATABASE_URL`, it polls Polymarket Data API directly, stores qualifying trades in `candidate_*` tables, backfills newly seen wallets for 30 days, keeps active copied wallets queued for 90 days of card history, resolves markets through Gamma, and serves the dashboard Candidates tab from `/api/candidates/leaderboard`.

The Real dashboard has a scored traders tab backed by cached `real_copy_quality_scores`. It ranks active copy-pool and baseline wallets by copier-specific Copy Quality Score using median entry, conservative copy edge, profit factor, drawdown/profit ratio, sample size, and top-win concentration. This is decision support only; it does not auto-add wallets to Real follows.

## Environment

Optional:

- `PORT`: backend port, defaults to `4101`.
- `HOST`: server bind host, defaults to `0.0.0.0`.
- `POLYWHALE_API_BASE_URL`: defaults to `https://whaleserver-production.up.railway.app`.
- `POLYMARKET_DATA_API_URL`: defaults to `https://data-api.polymarket.com`.
- `POLYMARKET_GAMMA_URL`: defaults to `https://gamma-api.polymarket.com`.
- `POLYMARKET_CLOB_URL`: defaults to `https://clob.polymarket.com`.
- `POLL_INTERVAL_MS`: defaults to `20000`.
- `RESOLUTION_POLL_INTERVAL_MS`: defaults to `60000`.
- `DEMO_STARTING_CAPITAL_USD`: defaults to `1000`.
- `DEMO_MAX_ENTRY_PRICE_CENTS`: defaults to `75`.
- `CANDIDATE_TRACKER_ENABLED`: enables the isolated candidate tracker, defaults to `false`.
- `CANDIDATE_MIN_USD`: defaults to `1000`.
- `CANDIDATE_MAX_USD`: exclusive maximum, defaults to `10000`.
- `CANDIDATE_BACKFILL_DAYS`: defaults to `30`.
- `CANDIDATE_ACCEPTED_HISTORY_DAYS`: active copied candidate wallet history window for month cards, defaults to `90`.
- `CANDIDATE_POLL_INTERVAL_MS`: defaults to `30000`.
- `CANDIDATE_BACKFILL_PAGE_LIMIT`: defaults to `500`.
- `CANDIDATE_BACKFILL_MAX_OFFSET`: defaults to `10000`.
- `CANDIDATE_RESOLUTION_BATCH_SIZE`: defaults to `250`.
- `AUTO_COPY_POOL_ENABLED`: enables automated candidate promotion/removal, defaults to `true`.
- `AUTO_COPY_MIN_DISTINCT_MARKETS`: promotion and retention minimum resolved distinct BUY markets, defaults to `15`.
- `AUTO_COPY_MIN_WIN_RATE_PCT`: promotion win-rate threshold, defaults to `75`.
- `AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT`: lower retention/removal win-rate threshold, defaults to `70`.
- `AUTO_COPY_MAX_AEP_CENTS`: legacy/display AEP reference, defaults to `75`; auto promotion no longer rejects traders by AEP.
- `FETCH_TIMEOUT_MS`: defaults to `15000`.
- `FETCH_RETRY_COUNT`: defaults to `2`.
- `DASHBOARD_AUTH_TOKEN`: optional token for dashboard APIs and websocket updates.
- `REAL_ACTION_PIN`: PIN required for Real add/remove actions, defaults to `1993`.
- `REAL_TRADING_MODE`: `dry_run` by default. Set to `live` only when the live credential variables below are configured.
- `REAL_LIVE_TRADING_ENABLED`: second live-execution gate, defaults to `false`; must be `true` with `REAL_TRADING_MODE=live`.
- `REAL_STAKE_USD`: fixed live/dry-run Real stake, defaults to `10`. `REAL_DRY_RUN_STAKE_USD` is still accepted for old dry-run setups.
- `REAL_PRICE_GUARD_CENTS`: strict source-price guard in cents, defaults to `4`.
- `REAL_MAX_ENTRY_PRICE_CENTS`: maximum source BUY price Real will copy, defaults to `75`.
- `REAL_FOLLOW_POLL_INTERVAL_MS`: Real follow Data API poll interval, defaults to `30000`.
- `REAL_FOLLOW_POLL_LIMIT`: per-wallet Real follow trade poll limit, defaults to `100`.
- `POLYMARKET_PRIVATE_KEY`: signing key for the owner/session wallet. Required for live orders.
- `POLYMARKET_FUNDER_ADDRESS`: Polymarket deposit/proxy/safe wallet address that funds orders. `POLYMARKET_DEPOSIT_WALLET_ADDRESS` and `DEPOSIT_WALLET_ADDRESS` are also accepted aliases.
- `POLYMARKET_SIGNATURE_TYPE`: Polymarket signature type. Defaults to `3` for deposit wallet / `POLY_1271`; use `1` for proxy wallets, `2` for Safe, `0` only for standalone EOA.
- `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`: optional CLOB L2 credentials. If omitted, the app derives credentials from `POLYMARKET_PRIVATE_KEY`.
- `POLYMARKET_BUILDER_CODE`: optional bytes32 builder code for attribution.
- `DEBUG_STATE_INCLUDE_ALL_TRADES`: defaults to `false`.
- `DATABASE_URL`: Postgres connection string used to persist demo state and trade history.

Live order submission uses Polymarket's CLOB v2 SDK. It still keeps the existing gates: dashboard auth, PIN-gated follow changes, followed-wallet-only polling, new-trades-only copying, fixed stake, max entry price, one position per market, FOK order type, source-price guard, and duplicate source-trade prevention. Real routes require `DASHBOARD_AUTH_TOKEN`; add/remove also requires `REAL_ACTION_PIN`.
