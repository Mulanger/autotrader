import express from 'express';
import { assertPin } from './service.js';

export function createRealRoutes(realService, candidateTracker = null) {
  const router = express.Router();

  router.get('/state', async (_request, response) => {
    try {
      response.json(await realService.getState());
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.get('/orders', async (_request, response) => {
    try {
      const state = await realService.getState();
      response.json({ ok: true, orders: state.orders || [] });
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.get('/positions', async (_request, response) => {
    try {
      const state = await realService.getState();
      response.json({ ok: true, positions: state.positions || [] });
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.get('/copy-quality', async (request, response) => {
    try {
      if (!candidateTracker?.getRealCopyQualityLeaderboard) {
        response.status(503).json({ ok: false, error: 'Real copy quality scoring is unavailable' });
        return;
      }
      const payload = await candidateTracker.getRealCopyQualityLeaderboard({
        limit: boundedInteger(request.query.limit, 100, 1, 250),
        offset: boundedInteger(request.query.offset, 0, 0, 100_000),
        q: request.query.q || '',
        tier: request.query.tier || 'all',
        eligible: parseOptionalBoolean(request.query.eligible),
        sort: request.query.sort || 'expectedProfit',
        order: request.query.order || 'desc',
      });
      const follows = await realFollowMap(realService);
      response.json({
        ...payload,
        rows: (payload.rows || []).map((row) => ({
          ...row,
          realFollowStatus: follows[String(row.wallet || '').toLowerCase()]?.status || null,
        })),
      });
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.get('/copy-quality/:wallet', async (request, response) => {
    try {
      if (!candidateTracker?.getRealCopyQualityScore) {
        response.status(503).json({ ok: false, error: 'Real copy quality scoring is unavailable' });
        return;
      }
      const row = await candidateTracker.getRealCopyQualityScore(request.params.wallet);
      if (!row) {
        response.status(404).json({ ok: false, error: 'Real copy quality score not found' });
        return;
      }
      const follows = await realFollowMap(realService);
      response.json({
        ok: true,
        row: {
          ...row,
          realFollowStatus: follows[String(row.wallet || '').toLowerCase()]?.status || null,
        },
      });
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.post('/copy-quality/recalculate', async (request, response) => {
    try {
      assertPin(request.body?.pin);
      if (!candidateTracker?.recalculateRealCopyQuality) {
        response.status(503).json({ ok: false, error: 'Real copy quality scoring is unavailable' });
        return;
      }
      const result = await candidateTracker.recalculateRealCopyQuality({
        scope: normalizeCopyQualityScope(request.body?.scope),
      });
      response.json(result);
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.post('/copy-quality/:wallet/recalculate', async (request, response) => {
    try {
      assertPin(request.body?.pin);
      if (!candidateTracker?.recalculateRealCopyQuality) {
        response.status(503).json({ ok: false, error: 'Real copy quality scoring is unavailable' });
        return;
      }
      const result = await candidateTracker.recalculateRealCopyQuality({ wallet: request.params.wallet });
      response.json(result);
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.post('/follow', async (request, response) => {
    try {
      const result = await realService.followTrader(request.body || {});
      response.json(result);
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.post('/unfollow', async (request, response) => {
    try {
      const result = await realService.unfollowTrader(request.body || {});
      response.json(result);
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  router.post('/unfollow-all', async (request, response) => {
    try {
      const result = await realService.unfollowAllTraders(request.body || {});
      response.json(result);
    } catch (error) {
      response.status(statusCode(error)).json({ ok: false, error: error.message });
    }
  });

  return router;
}

async function realFollowMap(realService) {
  const state = await realService.getState();
  const follows = {};
  for (const follow of state?.follows || []) {
    follows[String(follow.wallet || '').toLowerCase()] = follow;
  }
  return follows;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function parseOptionalBoolean(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'all') return null;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return null;
}

function normalizeCopyQualityScope(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'all_candidates') return 'all_candidates';
  if (text === 'active_copy_pool') return 'active_copy_pool';
  if (text === 'active_scored') return 'active_scored';
  return 'all_candidates';
}

function statusCode(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  return 500;
}
