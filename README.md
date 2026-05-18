# Polywhale Autotrader

Local copy-trading workbench for selected Polywhale leaderboard wallets.

Current state:

- Demo trading only: starts with `$100` cash and uses `$10` per copied buy.
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

## Environment

Optional:

- `PORT`: backend port, defaults to `4101`.
- `HOST`: server bind host, defaults to `0.0.0.0`.
- `POLYWHALE_API_BASE_URL`: defaults to `https://whaleserver-production.up.railway.app`.
- `POLL_INTERVAL_MS`: defaults to `20000`.

Real-money trading is not implemented in this scaffold. Do not put wallet private keys into this app until a real execution adapter, signing flow, and risk gates are reviewed.
