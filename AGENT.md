# Polywhale Autotrader Agent Handoff

This repo is the first version of a Polywhale copy-trading workbench. It watches a fixed list of leaderboard wallets, simulates copy trades with paper money, and renders a Railway-hosted dashboard for monitoring watched-wallet activity, demo positions, P/L, and eventual live-trading readiness.

Current production URL:

```text
https://autotrader-production-317c.up.railway.app/
```

GitHub remote:

```text
https://github.com/Mulanger/autotrader.git
```

## Current Status

- Main branch: `main`
- Runtime: one Node/Express service serving both backend API/websocket and built React app.
- Frontend: Vite + React.
- Backend: Express + `ws`.
- Persistence: Postgres when `DATABASE_URL` exists, memory fallback otherwise.
- Live source data: Polywhale whale API at `https://whaleserver-production.up.railway.app`.
- Real dashboard: dry-run by default. Manual follows can be added/removed behind dashboard auth + PIN, and copied BUY entries are quote-audited as fixed-stake FOK dry-runs. Live CLOB order submission is available only when `REAL_TRADING_MODE=live`, `REAL_LIVE_TRADING_ENABLED=true`, and Polymarket signing/funder variables are configured.

The dashboard is a demo/paper-trading system right now:

- Starting demo capital: `$1,000`.
- Fixed copy size: `$10`.
- Max copied entry price: `75c`. Watched BUY trades above this price are skipped.
- Only watched wallets can appear in the main copy-list tape.
- Historical trades loaded during startup are displayed as context but are not copied.
- New eligible watched `BUY` trades after service startup can open demo positions.
- Repeat entries from the same wallet on the same market are skipped after the first copied entry.
- On restore, older duplicate positions are pruned so only the earliest copied trader-market position remains.
- Watched `SELL` trades are observed but do not close demo positions.
- Open demo positions are settled by a separate resolution loop after Polywhale reports the official market outcome.

## Watched Wallets

Defined in `server/watched-wallets.js` and re-exported by `server/config.js`. The frontend reads the active list from `/api/state`; do not duplicate wallet constants in `src/`.

```text
0x531b33c5e7b8c2610917f883a13a1b8b1a706022
0x1887879a1bda615e88f280b582514c7d54e2678a
0xc2e7800b5af46e6093872b177b7a5e7f0563be51
0x7c585894ec02d5ed4fcd118ad8982f859360a5a1
0x93abbc022ce98d6f45d4444b594791cc4b7a9723
0xdd92232bcdfbbac04132b3cbacbf32c2e5b16b2a
0x8b5239494dd65eed682f0d9f0481ddeae4ff568e
0xf9c1190aa8184bcbe418e6f5321c53b0bfbc39e2
0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227
```

When changing this list, update both locations or refactor the frontend to fetch the list only from `/api/state`.

## Project Shape

```text
D:\autotrader
  AGENT.md              This handoff file.
  README.md             Short setup and Railway notes.
  package.json          npm scripts and dependencies.
  package-lock.json     Locked dependency tree.
  railway.json          Railway build/start/healthcheck config.
  vite.config.js        Vite config and local `/api` proxy.
  index.html            Vite HTML shell.
  server/
    index.js            Express server, API routes, static serving, websocket fanout.
    config.js           API URLs, ports, demo risk settings.
    watched-wallets.js  Single backend-owned watched wallet list.
    stream-service.js   Polywhale websocket connection, reconnect, REST polling, bootstrap.
    polywhale-client.js REST reads from Polywhale API.
    trade-normalizer.js Normalizes API/websocket whale trade records.
    fee-model.js        Paper fee handling when upstream fee metadata is available.
    demo-engine.js      Paper copy-trading rules and P/L math.
    app-state.js        In-memory app state, snapshots, serialization, restore.
    storage.js          Postgres persistence with memory fallback.
    format.js           Small formatting/time helpers.
    real/               Real follow storage, routes, dry-run quote checks, and optional live CLOB execution.
  src/
    main.jsx            React dashboard, demo/real tabs, tape, positions, trader cards.
    styles.css          Dashboard styling and responsive layout.
  dist/                 Generated build output; do not edit manually.
  node_modules/         Local dependencies; do not commit.
```

## Commands

```powershell
npm install
npm run dev
npm run build
npm start
```

Local development:

- Frontend: `http://127.0.0.1:5173`
- Backend API/WebSocket: `http://127.0.0.1:4101`
- `vite.config.js` proxies `/api` to `http://127.0.0.1:4101`.
- The frontend websocket code connects to `127.0.0.1:4101/events` when running on Vite port `5173`.

Production/Railway:

- Build: `npm run build`
- Start: `npm start`
- Healthcheck: `/api/health`
- `server/index.js` serves `dist/` and keeps `/api/*` plus `/events` on the same origin.
- Express starts before Postgres initialization finishes, so `/api/health` remains available even when database variables are wrong or the database is temporarily unavailable.

## Environment Variables

- `PORT`: server port. Railway provides this. Local default is `4101`.
- `HOST`: bind host. Defaults to `0.0.0.0`.
- `POLYWHALE_API_BASE_URL`: upstream API base. Defaults to `https://whaleserver-production.up.railway.app`.
- `POLYMARKET_DATA_API_URL`: direct Polymarket Data API for the independent `$1k-$10k` candidate tracker. Defaults to `https://data-api.polymarket.com`.
- `POLYMARKET_GAMMA_URL`: direct Polymarket Gamma fallback for market resolution checks. Defaults to `https://gamma-api.polymarket.com`.
- `POLYMARKET_CLOB_URL`: Polymarket CLOB API for public order book reads and optional Real live submission. Defaults to `https://clob.polymarket.com`.
- `POLL_INTERVAL_MS`: REST fallback poll interval. Defaults to `20000`.
- `RESOLUTION_POLL_INTERVAL_MS`: open-position resolution reconciliation interval. Defaults to `60000`.
- `DEMO_STARTING_CAPITAL_USD`: demo portfolio starting cash. Defaults to `1000`.
- `DEMO_MAX_ENTRY_PRICE_CENTS`: maximum BUY entry price to copy. Defaults to `75`.
- `CANDIDATE_TRACKER_ENABLED`: enables the isolated candidate tracker. Defaults to `false`.
- `CANDIDATE_MIN_USD`: candidate tracker minimum trade notional. Defaults to `1000`.
- `CANDIDATE_MAX_USD`: candidate tracker exclusive maximum trade notional. Defaults to `10000`.
- `CANDIDATE_BACKFILL_DAYS`: first-seen candidate wallet history window. Defaults to `30`.
- `CANDIDATE_ACCEPTED_HISTORY_DAYS`: deeper history window for active copied candidate wallets. Defaults to `90`.
- `CANDIDATE_POLL_INTERVAL_MS`: candidate Data API poll interval. Defaults to `30000`.
- `CANDIDATE_BACKFILL_PAGE_LIMIT`: candidate wallet backfill page size. Defaults to `500`.
- `CANDIDATE_BACKFILL_MAX_OFFSET`: deepest candidate backfill Data API offset before marking a partial backfill. Defaults to `10000`.
- `CANDIDATE_RESOLUTION_BATCH_SIZE`: minimum candidate resolution worker batch size. Defaults to `250`.
- `AUTO_COPY_POOL_ENABLED`: enables automated promotion/removal from the demo copy pool. Defaults to `true`.
- `AUTO_COPY_POOL_INTERVAL_MS`: copy-pool evaluator interval. Defaults to `300000`.
- `AUTO_COPY_MIN_DISTINCT_MARKETS`: minimum trailing 30-day resolved distinct BUY markets. Defaults to `15`.
- `AUTO_COPY_MIN_WIN_RATE_PCT`: minimum trailing 30-day distinct-market win rate for auto promotion. Defaults to `75`.
- `AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT`: lower trailing 30-day distinct-market win rate used before removing active auto-added traders. Defaults to `70`.
- `AUTO_COPY_MAX_AEP_CENTS`: legacy/display trailing 30-day BUY AEP reference. Defaults to `75`; auto promotion and retention do not reject traders by AEP.
- `FETCH_TIMEOUT_MS`: timeout for upstream Polywhale, Gamma, and Data API requests. Defaults to `15000`.
- `FETCH_RETRY_COUNT`: retry count for transient upstream 429/5xx/network failures. Defaults to `2`.
- `POLYGON_RPC_URL`: Polygon RPC endpoint for live Polymarket signing/SDK calls. Defaults to `https://polygon-rpc.com`; aliases: `POLYMARKET_RPC_URL`, `RPC_URL`.
- `DASHBOARD_AUTH_TOKEN`: optional bearer/query token for `/api/state`, `/api/candidates/*`, and `/events`. Empty disables dashboard auth.
- `REAL_ACTION_PIN`: PIN required for Real add/remove actions. Defaults to `1993`. Real routes are unavailable unless `DASHBOARD_AUTH_TOKEN` is configured.
- `REAL_TRADING_MODE`: Real execution mode. Defaults to `dry_run`; set to `live` only with live credentials configured.
- `REAL_LIVE_TRADING_ENABLED`: second live-execution gate. Defaults to `false`; must be `true` with `REAL_TRADING_MODE=live`.
- `REAL_STAKE_USD`: fixed Real live/dry-run stake. Defaults to `REAL_DRY_RUN_STAKE_USD` or `10`.
- `REAL_DRY_RUN_STAKE_USD`: legacy fixed Real dry-run quote size. Defaults to `10`.
- `REAL_PRICE_GUARD_CENTS`: maximum cents above the source BUY price allowed for Real quote checks and live order price limits. Defaults to `4`.
- `REAL_MAX_ENTRY_PRICE_CENTS`: maximum source BUY price Real will copy. Defaults to `75`.
- `REAL_MAX_SOURCE_TRADE_AGE_SECONDS`: maximum age for a followed source trade before Real skips it without recording an order attempt. Defaults to `45`; set `0` to disable.
- `REAL_FOLLOW_POLL_INTERVAL_MS`: Real follow Data API poll interval. Defaults to `30000`.
- `REAL_FOLLOW_POLL_LIMIT`: per-wallet Real follow Data API poll limit. Defaults to `100`.
- `POLYMARKET_PRIVATE_KEY`: signing key for the owner/session wallet. Required for live Real orders.
- `POLYMARKET_FUNDER_ADDRESS`: Polymarket deposit/proxy/safe wallet address that funds live orders. Aliases: `POLYMARKET_DEPOSIT_WALLET_ADDRESS`, `DEPOSIT_WALLET_ADDRESS`.
- `POLYMARKET_SIGNATURE_TYPE`: Polymarket signature type. Defaults to `3` (`POLY_1271` deposit wallet); `1` proxy, `2` Safe, `0` standalone EOA.
- `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`: optional CLOB L2 credentials. If omitted, the app derives them from `POLYMARKET_PRIVATE_KEY`.
- `POLYMARKET_BUILDER_CODE`: optional bytes32 builder code for attribution.
- `DEBUG_STATE_INCLUDE_ALL_TRADES`: includes unrelated all-trade debug payloads in `/api/state` when true. Defaults to `false`.
- `DATABASE_URL`: Postgres connection string. Required for durable demo state.
- `PGSSLMODE`: optional. Set to `require` or `disable` to override Postgres SSL behavior.

## Railway Setup

Railway deploys this repo as a single service using `railway.json`:

```text
Build: npm run build
Start: npm start
Healthcheck: /api/health
```

Add Railway Postgres to the project/service. Railway should inject `DATABASE_URL`. Without `DATABASE_URL`, the app works but displays `Storage memory only`, and demo state resets on process restart or redeploy.

The app creates normalized durable tables automatically:

```sql
autotrader_schema_migrations
autotrader_snapshots
autotrader_state          -- legacy JSON snapshot fallback only
demo_account
observed_trades
copy_decisions
demo_positions
trader_profiles
candidate_traders
candidate_trades
candidate_market_resolutions
candidate_service_state
copy_pool_traders
copy_pool_events
real_followed_traders
real_orders
real_positions
real_events
```

The primary durable model is normalized. `autotrader_snapshots` keeps a compact app snapshot for restore compatibility, while `observed_trades`, `copy_decisions`, `demo_positions`, `demo_account`, and `trader_profiles` are the audit/query tables. `candidate_*` tables power the `$1k-$10k` discovery leaderboard and feed the isolated automated copy-pool evaluator; `copy_pool_*` tables hold promotion/removal state and audit events. `autotrader_state` is kept only so older single-JSON deployments can be migrated on first successful save.

## Runtime Data Flow

1. Browser loads the built React app from the Express server.
2. React fetches `/api/state` for the initial dashboard snapshot.
3. React opens a websocket to `/events` for live dashboard updates.
4. Backend connects to `wss://whaleserver-production.up.railway.app/v1/whales/stream`.
5. Backend also polls `GET /v1/whales?limit=100&minUsd=10000` every `POLL_INTERVAL_MS`.
6. Startup bootstrap fetches recent whales plus recent history for watched wallets. These rows are marked as `loaded at startup` and are not copy-eligible.
7. Every normalized trade is added to the backend state once by `trade.id`.
8. If the trade wallet is watched, it enters `copiedFeed`; otherwise it stays out of the main tape.
9. Demo copy rules run only for watched events when copy eligibility is true.
10. A second backend reconciliation loop checks every open demo position by source trade id every `RESOLUTION_POLL_INTERVAL_MS`.
11. If Polywhale still reports open, the loop checks Polymarket Gamma directly by condition id or slug.
12. When Polywhale or Gamma returns a final outcome, the demo position is settled exactly once and moved into closed history.
13. After meaningful state changes, backend queues a normalized Postgres save and broadcasts the updated state to connected browsers.
14. On Railway shutdown, the server attempts one final storage flush before closing the pool.

## API Endpoints

Local/backend endpoints:

- `GET /api/health`: service, stream, poll, and storage health.
- `GET /api/state`: complete dashboard state snapshot.
- `GET /api/candidates/leaderboard`: independent `$1k-$10k` candidate trader leaderboard.
- `GET /api/candidates/traders/:wallet`: independent candidate trader profile and recent tracked trades.
- `GET /api/real/state`: Real dashboard state. Requires configured dashboard auth.
- `GET /api/real/copy-quality`: cached Real Copy Quality leaderboard for active copy-pool/baseline wallets.
- `GET /api/real/copy-quality/:wallet`: one wallet's cached Real Copy Quality score.
- `POST /api/real/copy-quality/recalculate`: PIN-gated Real Copy Quality rescore.
- `POST /api/real/copy-quality/:wallet/recalculate`: PIN-gated single-wallet Real Copy Quality rescore.
- `POST /api/real/follow`: PIN-gated manual Real follow add.
- `POST /api/real/unfollow`: PIN-gated manual Real follow removal.
- `GET /api/real/orders`: recent Real order audit rows.
- `GET /api/real/positions`: recent Real positions.
- `WS /events`: dashboard state updates.

Polywhale upstream endpoints used:

- `GET /v1/whales?limit=100&minUsd=10000`
- `GET /v1/whales?limit=...&minUsd=10000&traderWallet=<wallet>`
- `GET /v1/whales/<tradeId>`
- `GET /v1/whales/<tradeId>/detail` as a fallback for resolution/detail refreshes.
- `GET /v1/leaderboard?sort=profit&limit=100`
- `WS /v1/whales/stream`
- `GET https://gamma-api.polymarket.com/markets?...` as a direct resolution fallback.

## Demo Copy Rules

Implemented in `server/demo-engine.js`.

- `BUY`:
  - Requires a usable positive price.
  - Requires price <= `DEMO_MAX_ENTRY_PRICE_CENTS`, default `75c`.
  - Requires that the same trader wallet has not already been copied on the same market.
  - Requires demo cash >= `$10`.
  - Opens a demo position using `$10 / price`.
  - Reduces cash by `$10`.
  - Adds the source trade id to `copiedSourceTradeIds`.
  - Adds a `trader wallet + market` key to `copiedTraderMarketKeys` so later entries on the same market from the same trader are skipped.
- `SELL`:
  - Is recorded as skipped for demo execution.
  - Does not close paper inventory.
  - This is intentional: the demo follows the source BUY into the market and waits for the final market outcome.
- Resolution settlement:
  - Runs from `server/resolution-engine.js`.
  - Polls every open demo position's `sourceTradeId`.
  - Falls back to `server/polymarket-client.js` when Polywhale has not materialized a resolved outcome yet.
  - `resolved_win`: pays `$1` per copied share and records realized profit.
  - `resolved_loss`: pays `$0` and records the fixed stake as realized loss.
  - `invalid`: refunds the fixed stake and records zero realized P/L.
  - Moves settled positions from `openPositions` to `closedPositions`.
  - Writes settlement metadata: `resolutionStatus`, `winningOutcome`, `resolvedAt`, and `settlementSource`.
- Fee handling:
  - Runs from `server/fee-model.js`.
  - Polymarket taker fee formula is `fee = shares * feeRate * price * (1 - price)`.
  - Buy-side fees are modeled as share deductions because Polymarket collects buy fees in shares.
  - If upstream provides explicit `feeUsd`, the demo treats the fee as known.
  - If upstream provides `feesEnabled=true` plus `feeRateBps` or `feeRate`, the demo estimates the fee and reduces copied shares.
  - If upstream says fees are disabled or fee rate is zero, the demo records a known `$0` fee.
  - If upstream does not expose fee metadata, the demo marks the position `fee unknown` and leaves shares gross. Do not describe these P/L numbers as fully fee-net.
- Any unsupported side is skipped.
- Historical startup rows are never copied.

## Dashboard Views

Implemented in `src/main.jsx`.

- `Overview`: metrics, copy-list tape, current copied trades, watched trader cards.
- `Profit`: total P/L, realized/unrealized split, closed-trade history.
- `Positions`: full current open copied-trades list.
- `Traders`: watched-wallet cards with profit leaderboard metadata and recent watched trades.
- `Real`: separate control room for manual follows, scored Real copy candidates, quote-audited fixed-stake FOK attempts, and dry-run or live position performance depending on `REAL_TRADING_MODE`.

Main tape behavior:

- Shows only events from watched wallets (`copiedFeed`).
- Does not show unrelated whale trades.
- Source labels are user-facing:
  - `bootstrap` -> `loaded at startup`
  - `websocket` -> `live stream`
  - `poll` -> `poll sync`

## Health Signals

Sidebar statuses:

- `Dashboard live updates online`: browser is connected to `/events`.
- `Whale stream connected`: backend websocket to Polywhale is open.
- `REST poll ready/polling`: REST fallback is healthy. `polling` is active and should be green.
- `Resolution tracker ready/polling`: open demo positions are being checked for official market outcomes.
- `Storage ready/saving`: Postgres persistence is active.
- `Storage postgres_error`: `DATABASE_URL` exists but Postgres setup failed; inspect `/api/health` for `lastError`.
- `Storage memory only`: no `DATABASE_URL`; not durable.

Use the live health endpoint for direct verification:

```powershell
Invoke-RestMethod -Uri 'https://autotrader-production-317c.up.railway.app/api/health'
```

## Persistence Model

Durable state is serialized from `server/app-state.js` by `serializeDurableState()` and restored by `restoreDurableState()`. Storage is implemented in `server/storage.js`.

Current table responsibilities:

- `demo_account`: paper account cash, fixed stake, realized P/L, copied/skipped counts, notional copied.
- `observed_trades`: every retained whale event seen by the service, including source and watched flag.
- `copy_decisions`: every retained demo decision, including copied/skipped/observed and reason.
- `demo_positions`: open and closed paper positions with entry/exit prices, P/L, and full payload.
- `trader_profiles`: watched trader metadata, leaderboard rank/profit fields, and recent trade context.
- `autotrader_snapshots`: app-level restore snapshot.
- `autotrader_state`: legacy fallback from the earlier single JSON implementation.

`saveNormalizedState()` deletes `demo_positions` rows that are no longer present in the current durable state. This is intentional: the demo state is the source of truth after restore-time repairs such as duplicate trader-market pruning.

Persisted fields include:

- watched wallets
- trader cards and recent watched trades
- all recent observed events
- copy-list feed
- demo cash, realized P/L, copied/skipped counts
- open positions
- closed positions
- settlement metadata for resolved positions
- fee status and known/estimated entry fees
- copy decisions
- copied source trade ids
- real-page status notes
- all known seen trade ids, so redeploys do not duplicate-copy old source trades

Without Postgres, all of the above is only in process memory and will be lost on redeploy/restart.

## Real Trading Boundary

The Real dashboard defaults to dry-run. In dry-run, it stores manual follows in `real_followed_traders`, polls Polymarket Data API for fresh post-add BUY trades, applies the max-entry and one-position-per-market gates, checks public CLOB order books, and records would-fill/rejected fixed-stake FOK attempts. Add/remove controls require configured `DASHBOARD_AUTH_TOKEN` plus `REAL_ACTION_PIN`.

Live order submission now uses a separate Polymarket CLOB v2 adapter in `server/real/live-executor.js`. It only arms when both `REAL_TRADING_MODE=live` and `REAL_LIVE_TRADING_ENABLED=true` are set and the required Polymarket signing/funder variables are present. Do not bypass these gates or call order endpoints from the demo path.

Preserve these live execution controls:

- wallet connection/signing model
- no private keys committed or pasted into source
- fixed stake, with future max daily loss / max open exposure controls still recommended
- one position per market across all manually followed Real traders
- max source entry price
- slippage/price bounds
- duplicate order protection
- market liquidity checks
- chain/order failure handling
- clear manual arming switch
- audit log for every attempted live order
- dry-run/live mode separation

## Important Cautions

- Do not re-add a demo reset button or reset API route without an explicit confirmation workflow. It was removed to avoid accidental state loss.
- Do not show unrelated whale trades in the main tape; it should stay focused on copied/watched wallets.
- Do not copy startup/historical trades. They are context only.
- Do not add trader sizing discipline, size-weighted win rate, confidence-based stake scaling, or trader-level AEP caps as hard copy-pool rules without new evidence. A read-only production backtest on May 26, 2026 found the sizing ideas worsened or failed to improve the fixed-stake strategy. AEP is currently display-only because individual entries above the max copy price are already skipped by the demo execution rule.
- Do not treat `Storage memory only` as production-safe.
- Keep `dist/`, logs, and `node_modules/` out of commits.
- Check `git status` before edits and avoid reverting unrelated user work.

## Sizing Backtest Findings

On May 26, 2026, a temporary local analysis script was used against Railway Postgres in a read-only transaction to test trader sizing discipline and confidence-based stake scaling. The script was removed afterward so it does not remain part of the product codebase.

Dataset at the time:

- Candidate trades loaded: `149,712`
- Candidate resolved BUY rows: `88,221`
- Demo positions loaded: `113`
- Demo resolved positions: `87`
- Active copy-pool traders: `97`

Sizing as a filter did not help the larger candidate forward simulation:

```text
Baseline             1620 copies, 1518 resolved, 61.3% win rate, +$1609.13 P/L, 10.6% ROI
Conservative sizing  1491 copies, 1404 resolved, 60.8% win rate, +$1410.20 P/L, 10.0% ROI
Moderate sizing      1240 copies, 1164 resolved, 59.8% win rate,  +$991.18 P/L,  8.5% ROI
Strict sizing         649 copies,  606 resolved, 57.9% win rate,  +$414.01 P/L,  6.8% ROI
```

Confidence-based stake scaling increased absolute P/L only by deploying more capital; ROI fell slightly and drawdown rose:

```text
Fixed $10           avg stake $10.00, +$1609.13 P/L, 10.6% ROI, $283.63 max drawdown
Mild scaling        avg stake $14.23, +$2263.11 P/L, 10.5% ROI, $416.10 max drawdown
Aggressive scaling  avg stake $18.47, +$2916.99 P/L, 10.4% ROI, $548.56 max drawdown
```

Conclusion: keep fixed `$10` sizing. Keep resolved distinct-market count and win rate as the hard copy-pool gates. AEP is display-only, because the execution engine already skips individual entries above the max copy price. Do not repeat similar sizing/filter simulations unless the copy strategy changes materially, such as moving from fixed stake to proportional live stake sizing.

## Copy-Pool Hysteresis

On May 26, 2026, a read-only production simulation tested whether the auto copy pool was too aggressive about removals. The best first production change was to keep the promotion gate unchanged but lower the removal win-rate threshold:

```text
Current add 75 / remove 75: 1621 copies, 1519 resolved, +$1599.13 P/L, 10.5% ROI, 146 removals
Hysteresis add 75 / remove 70: 1846 copies, 1740 resolved, +$1769.29 P/L, 10.2% ROI, 76 removals
```

The system now uses `AUTO_COPY_MIN_WIN_RATE_PCT` for promotion and `AUTO_COPY_REMOVE_MIN_WIN_RATE_PCT` for retention/removal. The default is add at `75%` and remove below `70%`, with the same `15` distinct-market gate. AEP stays visible as a metric but is not a follow/removal gate. This reduces churn from normal win-rate variance while preserving the original promotion standard.

## Recommended Next Work

1. Add a proper history/export page with filters by wallet, market, copied/skipped, and win/loss.
2. Add a direct Polymarket market-resolution fallback if Polywhale resolution data lags or is unavailable.
3. Add direct CLOB fee-rate lookups by token id once token ids are available in the copied trade/market payload.
4. Add a durable `service_events` table for stream disconnects, poll failures, deploy starts, and storage errors.
5. Add end-to-end tests against a disposable Postgres instance.
6. Add authentication before any real-money execution controls exist on a public URL.
7. Expand tests for persistence restore/save behavior against real SQL, not only unit-level state restore.

## Verification Checklist

Before pushing:

1. Run `npm run build`.
2. Run `npm test`.
3. Check `/api/health` locally or on Railway.
4. Confirm the sidebar stream/poll/storage states are understandable.
5. Confirm the main tape only shows watched-wallet trades.
6. Confirm no reset control exists.
7. Confirm `Real` mode still cannot place live trades.
8. If persistence changed, test restore behavior with a real or local Postgres `DATABASE_URL`.
