import { DASHBOARD_AUTH_TOKEN } from './config.js';

export function isDashboardAuthEnabled() {
  return Boolean(dashboardAuthToken());
}

export function isAuthorizedRequest(request) {
  if (!isDashboardAuthEnabled()) return true;
  const token = tokenFromRequest(request);
  return token === dashboardAuthToken();
}

export function requireDashboardAuth(request, response, next) {
  if (isAuthorizedRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ ok: false, error: 'Unauthorized' });
}

export function requireConfiguredDashboardAuth(request, response, next) {
  if (!isDashboardAuthEnabled()) {
    response.status(403).json({
      ok: false,
      error: 'Dashboard auth must be configured before real trading controls are available',
    });
    return;
  }
  requireDashboardAuth(request, response, next);
}

export function redactServiceForPublicHealth(service) {
  if (!isDashboardAuthEnabled()) return service;
  return {
    ...service,
    lastError: service.lastError ? 'redacted' : null,
    storage: service.storage
      ? {
          ...service.storage,
          lastError: service.storage.lastError ? 'redacted' : null,
        }
      : service.storage,
    candidates: service.candidates
      ? {
          ...service.candidates,
          lastBackfillWallet: service.candidates.lastBackfillWallet ? 'redacted' : null,
          lastError: service.candidates.lastError ? 'redacted' : null,
        }
      : service.candidates,
    real: service.real
      ? {
          ...service.real,
          lastError: service.real.lastError ? 'redacted' : null,
        }
      : service.real,
  };
}

function tokenFromRequest(request) {
  const auth = String(request.headers?.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (
    String(request.headers?.['x-dashboard-token'] || '').trim() ||
    String(request.headers?.['x-autotrader-token'] || '').trim() ||
    tokenFromUrl(request.url)
  );
}

function tokenFromUrl(url) {
  try {
    const parsed = new URL(url || '/', 'http://localhost');
    return parsed.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function dashboardAuthToken() {
  return process.env.DASHBOARD_AUTH_TOKEN || DASHBOARD_AUTH_TOKEN;
}
