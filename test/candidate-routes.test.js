import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateRoutes } from '../server/candidate-tracker/routes.js';

let server;

afterEach(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

function startApp(tracker) {
  const app = express();
  app.use('/api/candidates', createCandidateRoutes(tracker));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe('candidate routes', () => {
  it('returns leaderboard response shape', async () => {
    const base = await startApp({
      getLeaderboard: async () => ({
        ok: true,
        enabled: true,
        status: 'ready',
        summary: { traderCount: 1, tradeCount: 2 },
        rows: [{ wallet: '0xaaa', rank: 1 }],
      }),
      getTrader: async () => null,
    });

    const response = await fetch(`${base}/api/candidates/leaderboard?limit=50`);
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(payload.enabled).toBe(true);
    expect(payload.rows).toHaveLength(1);
    expect(payload.summary.traderCount).toBe(1);
  });

  it('passes pagination params to trader detail lookups', async () => {
    let detailParams = null;
    const base = await startApp({
      getLeaderboard: async () => ({ ok: true, enabled: true, rows: [], summary: {} }),
      getTrader: async (_wallet, params) => {
        detailParams = params;
        return { wallet: '0xaaa', totalTrackedTradeCount: 0, trades: [] };
      },
    });

    const response = await fetch(`${base}/api/candidates/traders/0xaaa?limit=75&offset=150`);
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(payload.wallet).toBe('0xaaa');
    expect(detailParams).toEqual({ limit: 75, offset: 150 });
  });

  it('returns 404 for missing candidate trader details', async () => {
    const base = await startApp({
      getLeaderboard: async () => ({ ok: true, enabled: false, rows: [], summary: {} }),
      getTrader: async () => null,
    });

    const response = await fetch(`${base}/api/candidates/traders/0xmissing`);

    expect(response.status).toBe(404);
  });

  it('triggers shadow trader recalculation', async () => {
    let called = false;
    const base = await startApp({
      getLeaderboard: async () => ({ ok: true, enabled: true, rows: [], summary: {} }),
      getTrader: async () => null,
      runShadowTraderEvaluation: async () => {
        called = true;
        return { ok: true, strategy: 'ecp_top20_v1', selectedWalletCount: 20 };
      },
    });

    const response = await fetch(`${base}/api/candidates/shadow/recalculate`, { method: 'POST' });
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(called).toBe(true);
    expect(payload.selectedWalletCount).toBe(20);
  });

  it('triggers a forced maintenance run', async () => {
    let params = null;
    const base = await startApp({
      getLeaderboard: async () => ({ ok: true, enabled: true, rows: [], summary: {} }),
      getTrader: async () => null,
      runMaintenance: async (input) => {
        params = input;
        return { ok: true, status: 'done', shadowObservedTradeCount: 2 };
      },
    });

    const response = await fetch(`${base}/api/candidates/maintenance/run?forceScoring=false`, { method: 'POST' });
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(params).toEqual({ force: false, forceFetch: true, forceScoring: false });
    expect(payload.shadowObservedTradeCount).toBe(2);
  });

  it('triggers shadow-only observation', async () => {
    let params = null;
    const base = await startApp({
      getLeaderboard: async () => ({ ok: true, enabled: true, rows: [], summary: {} }),
      getTrader: async () => null,
      runShadowObservation: async (input) => {
        params = input;
        return { ok: true, status: 'done', walletCount: 20, shadowObservedTradeCount: 3 };
      },
    });

    const response = await fetch(`${base}/api/candidates/shadow/observe?lookbackHours=24`, { method: 'POST' });
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(params).toEqual({ lookbackHours: 24 });
    expect(payload.walletCount).toBe(20);
    expect(payload.shadowObservedTradeCount).toBe(3);
  });
});
