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

function startApp(realService) {
  const app = express();
  app.use(express.json());
  app.use('/api/real', requireConfiguredDashboardAuth, createRealRoutes(realService));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function fakeService() {
  return {
    getState: async () => ({
      ok: true,
      summary: { activeFollowCount: 1 },
      follows: [{ wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' }],
      orders: [],
      positions: [],
    }),
    followTrader: async () => ({ ok: true }),
    unfollowTrader: async () => ({ ok: true }),
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

  it('requires configured dashboard auth and maps real state', async () => {
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
  });
});
