import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { isAuthorizedRequest, requireDashboardAuth } from '../server/auth.js';

let server;
const previousToken = process.env.DASHBOARD_AUTH_TOKEN;

afterEach(async () => {
  process.env.DASHBOARD_AUTH_TOKEN = previousToken;
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

function startProtectedApp() {
  const app = express();
  app.get('/api/state', requireDashboardAuth, (_request, response) => response.json({ ok: true }));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

describe('dashboard auth', () => {
  it('allows access when no dashboard token is configured', async () => {
    delete process.env.DASHBOARD_AUTH_TOKEN;
    const base = await startProtectedApp();

    const response = await fetch(`${base}/api/state`);

    expect(response.status).toBe(200);
  });

  it('requires bearer token when dashboard token is configured', async () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';
    const base = await startProtectedApp();

    const denied = await fetch(`${base}/api/state`);
    const allowed = await fetch(`${base}/api/state`, {
      headers: { Authorization: 'Bearer secret-token' },
    });

    expect(denied.status).toBe(401);
    expect(allowed.status).toBe(200);
  });

  it('authorizes websocket-style query tokens', () => {
    process.env.DASHBOARD_AUTH_TOKEN = 'secret-token';

    expect(isAuthorizedRequest({ headers: {}, url: '/events?token=secret-token' })).toBe(true);
    expect(isAuthorizedRequest({ headers: {}, url: '/events?token=wrong' })).toBe(false);
  });
});
