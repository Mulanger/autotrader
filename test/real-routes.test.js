import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { requireConfiguredDashboardAuth } from '../server/auth.js';
import { createRealRoutes } from '../server/real/routes.js';

let server;
const previousToken = process.env.DASHBOARD_AUTH_TOKEN;

afterEach(async () => {
  process.env.DASHBOARD_AUTH_TOKEN = previousToken;
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

function startApp(realService, candidateTracker = null) {
  const app = express();
  app.use(express.json());
  app.use('/api/real', requireConfiguredDashboardAuth, createRealRoutes(realService, candidateTracker));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function fakeService(snapshot = null) {
  return {
    getState: async () => ({
      ok: true,
      summary: { activeFollowCount: 1 },
      follows: [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' }],
      orders: [],
      positions: [],
      runtime: snapshot?.runtime || null,
      account: snapshot?.account || null,
    }),
    followTrader: async () => ({ ok: true }),
    unfollowTrader: async () => ({ ok: true }),
    unfollowAllTraders: async () => ({ ok: true, removedCount: 1 }),
  };
}

describe('real routes', () => {
  it('refuses real routes when dashboard auth is not configured', async () => {
    delete process.env.DASHBOARD_AUTH_TOKEN;
    const base = await startApp(fakeService());

    const response = await fetch(`${base}/api/real/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pin: '1993' }),
    });

    expect(response.status).toBe(403);
  });

  it('requires configured dashboard auth and maps real state with no worker snapshot', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    const base = await startApp(fakeService());

    const denied = await fetch(`${base}/api/real/state`);
    const allowed = await fetch(`${base}/api/real/state`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    const payload = await allowed.json();

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(payload.summary.activeFollowCount).toBe(1);
    expect(payload.runtime).toBeNull();
    expect(payload.account).toBeNull();
  });

  it('includes the latest real worker runtime and account snapshot when present', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    const base = await startApp(fakeService({
      runtime: {
        role: 'worker',
        status: 'ready',
        heartbeatAt: '2026-05-28T09:00:00.000Z',
        liveExecutionReady: true,
      },
      account: {
        ok: true,
        signerAddress: '0x1111111111111111111111111111111111111111',
        collateral: { balanceUsd: 12.5 },
      },
    }));

    const response = await fetch(`${base}/api/real/state`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.runtime.role).toBe('worker');
    expect(payload.runtime.liveExecutionReady).toBe(true);
    expect(payload.account.collateral.balanceUsd).toBe(12.5);
  });

  it('passes all-candidate copy-quality recalculation through by default', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    let requestedScope = null;
    const candidateTracker = {
      recalculateRealCopyQuality: async ({ scope }) => {
        requestedScope = scope;
        return { ok: true, scope };
      },
    };
    const base = await startApp(fakeService(), candidateTracker);

    const response = await fetch(`${base}/api/real/copy-quality/recalculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ pin: '1993' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(requestedScope).toBe('all_candidates');
    expect(payload.scope).toBe('all_candidates');
  });

  it('passes score page sort and eligibility filters to copy-quality storage', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    let requestedParams = null;
    const candidateTracker = {
      getRealCopyQualityLeaderboard: async (params) => {
        requestedParams = params;
        return { ok: true, summary: {}, rows: [] };
      },
    };
    const base = await startApp(fakeService(), candidateTracker);

    const response = await fetch(`${base}/api/real/copy-quality?eligible=true&sort=expectedProfit`, {
      headers: { Authorization: 'Bearer secret-token' },
    });

    expect(response.status).toBe(200);
    expect(requestedParams).toMatchObject({ eligible: true, sort: 'expectedProfit' });
  });

  it('defaults copy-quality leaderboard sorting to expected profit', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    let requestedParams = null;
    const candidateTracker = {
      getRealCopyQualityLeaderboard: async (params) => {
        requestedParams = params;
        return { ok: true, summary: {}, rows: [] };
      },
    };
    const base = await startApp(fakeService(), candidateTracker);

    const response = await fetch(`${base}/api/real/copy-quality`, {
      headers: { Authorization: 'Bearer secret-token' },
    });

    expect(response.status).toBe(200);
    expect(requestedParams.sort).toBe('expectedProfit');
  });

  it('exposes a PIN-gated bulk unfollow route', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    let requestBody = null;
    const service = {
      ...fakeService(),
      unfollowAllTraders: async (body) => {
        requestBody = body;
        return { ok: true, removedCount: 2 };
      },
    };
    const base = await startApp(service);

    const response = await fetch(`${base}/api/real/unfollow-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ pin: '1993', confirmation: 'REMOVE ALL' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(requestBody).toEqual({ pin: '1993', confirmation: 'REMOVE ALL' });
    expect(payload.removedCount).toBe(2);
  });
});
