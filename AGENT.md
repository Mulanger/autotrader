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
- Real trading: intentionally disabled. Do not add private keys or live order submission without explicit risk-gate work.

The dashboard is a demo/paper-trading system right now:

- Starting demo capital: `$100`.
- Fixed copy size: `$10`.
- Only watched wallets can appear in the main copy-list tape.
- Historical trades loaded during startup are displayed as context but are not copied.
- New eligible watched `BUY` trades after service startup can open demo positions.
- Watched `SELL` trades only close a demo position when matching inventory exists.

## Watched Wallets

Defined in `server/config.js` and duplicated in `src/main.jsx` for display fallback:

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
    config.js           API URLs, ports, demo risk settings, watched wallets.
    stream-service.js   Polywhale websocket connection, reconnect, REST polling, bootstrap.
    polywhale-client.js REST reads from Polywhale API.
    trade-normalizer.js Normalizes API/websocket whale trade records.
    demo-engine.js      Paper copy-trading rules and P/L math.
    app-state.js        In-memory app state, snapshots, serialization, restore.
    storage.js          Postgres persistence with memory fallback.
    format.js           Small formatting/time helpers.
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

## Environment Variables

- `PORT`: server port. Railway provides this. Local default is `4101`.
- `HOST`: bind host. Defaults to `0.0.0.0`.
- `POLYWHALE_API_BASE_URL`: upstream API base. Defaults to `https://whaleserver-production.up.railway.app`.
- `POLL_INTERVAL_MS`: REST fallback poll interval. Defaults to `20000`.
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

The app creates this table automatically:

```sql
create table if not exists autotrader_state (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
```

Current storage strategy is one JSON document under key `default`. This is acceptable for the early demo, but a future version should split trades, positions, balance snapshots, and copy decisions into normalized tables for querying and auditability.

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
10. After meaningful state changes, backend queues a Postgres save and broadcasts the updated state to connected browsers.

## API Endpoints

Local/backend endpoints:

- `GET /api/health`: service, stream, poll, and storage health.
- `GET /api/state`: complete dashboard state snapshot.
- `WS /events`: dashboard state updates.

Polywhale upstream endpoints used:

- `GET /v1/whales?limit=100&minUsd=10000`
- `GET /v1/whales?limit=...&minUsd=10000&traderWallet=<wallet>`
- `GET /v1/leaderboard?sort=profit&limit=100`
- `WS /v1/whales/stream`

## Demo Copy Rules

Implemented in `server/demo-engine.js`.

- `BUY`:
  - Requires a usable positive price.
  - Requires demo cash >= `$10`.
  - Opens a demo position using `$10 / price`.
  - Reduces cash by `$10`.
  - Adds the source trade id to `copiedSourceTradeIds`.
- `SELL`:
  - Requires a usable positive price.
  - Searches for a matching open position by market slug and outcome.
  - If found, closes the position, realizes P/L, and returns cash.
  - If no matching inventory exists, logs a skipped decision.
- Any unsupported side is skipped.
- Historical startup rows are never copied.

Important current limitation: the demo does not yet resolve positions from market resolution data. It only marks closed win/loss when a watched `SELL` closes demo inventory. Future work should reconcile open demo positions against resolved market outcomes.

## Dashboard Views

Implemented in `src/main.jsx`.

- `Overview`: metrics, copy-list tape, current copied trades, watched trader cards.
- `Profit`: total P/L, realized/unrealized split, closed-trade history.
- `Positions`: full current open copied-trades list.
- `Traders`: watched-wallet cards with profit leaderboard metadata and recent watched trades.
- `Real`: separate read-only page showing live trading is not armed.

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
- `Storage ready/saving`: Postgres persistence is active.
- `Storage memory only`: no `DATABASE_URL`; not durable.

Use the live health endpoint for direct verification:

```powershell
Invoke-RestMethod -Uri 'https://autotrader-production-317c.up.railway.app/api/health'
```

## Persistence Model

Durable state is serialized from `server/app-state.js` by `serializeDurableState()` and restored by `restoreDurableState()`.

Persisted fields include:

- watched wallets
- trader cards and recent watched trades
- all recent observed events
- copy-list feed
- demo cash, realized P/L, copied/skipped counts
- open positions
- closed positions
- copy decisions
- copied source trade ids
- real-page status notes

Without Postgres, all of the above is only in process memory and will be lost on redeploy/restart.

## Real Trading Boundary

Real trading is intentionally not implemented.

Do not add live trading by simply calling an order endpoint from the current demo path. Real execution needs a separate adapter and explicit safety controls:

- wallet connection/signing model
- no private keys committed or pasted into source
- max stake, max daily loss, max open exposure
- slippage/price bounds
- duplicate order protection
- market liquidity checks
- chain/order failure handling
- clear manual arming switch
- audit log for every attempted order
- dry-run/live mode separation

The `Real` tab is currently read-only and should stay blocked until those pieces exist.

## Important Cautions

- Do not re-add a demo reset button or reset API route without an explicit confirmation workflow. It was removed to avoid accidental state loss.
- Do not show unrelated whale trades in the main tape; it should stay focused on copied/watched wallets.
- Do not copy startup/historical trades. They are context only.
- Do not treat `Storage memory only` as production-safe.
- Keep `dist/`, logs, and `node_modules/` out of commits.
- Check `git status` before edits and avoid reverting unrelated user work.

## Recommended Next Work

1. Attach Railway Postgres and confirm the sidebar shows durable storage instead of `Storage memory only`.
2. Split the single JSON state document into normalized tables:
   - `observed_trades`
   - `copy_decisions`
   - `demo_positions`
   - `demo_balance_snapshots`
   - `service_events`
3. Add a proper history/export page with filters by wallet, market, copied/skipped, and win/loss.
4. Add market-resolution reconciliation so open demo positions close from authoritative outcomes, not only watched `SELL` events.
5. Add authentication before any real-money execution controls exist on a public URL.
6. Add tests for `demo-engine.js`, `trade-normalizer.js`, and persistence restore/save behavior.

## Verification Checklist

Before pushing:

1. Run `npm run build`.
2. Check `/api/health` locally or on Railway.
3. Confirm the sidebar stream/poll/storage states are understandable.
4. Confirm the main tape only shows watched-wallet trades.
5. Confirm no reset control exists.
6. Confirm `Real` mode still cannot place live trades.
7. If persistence changed, test restore behavior with a real or local Postgres `DATABASE_URL`.
