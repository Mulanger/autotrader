import express from 'express';

export function createCandidateRoutes(candidateTracker) {
  const router = express.Router();

  router.get('/leaderboard', async (request, response) => {
    try {
      const limit = boundedInteger(request.query.limit, 100, 1, 250);
      const offset = boundedInteger(request.query.offset, 0, 0, 10_000);
      const payload = await candidateTracker.getLeaderboard({ limit, offset });
      response.json(payload);
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/traders/:wallet', async (request, response) => {
    try {
      const limit = boundedInteger(request.query.limit, 100, 1, 250);
      const offset = boundedInteger(request.query.offset, 0, 0, 100_000);
      const payload = await candidateTracker.getTrader(request.params.wallet, { limit, offset });
      if (!payload) {
        response.status(404).json({ ok: false, error: 'Candidate trader not found' });
        return;
      }
      response.json(payload);
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/shadow/recalculate', async (_request, response) => {
    try {
      if (!candidateTracker?.runShadowTraderEvaluation) {
        response.status(503).json({ ok: false, error: 'Shadow trader evaluation is unavailable' });
        return;
      }
      const payload = await candidateTracker.runShadowTraderEvaluation();
      response.status(payload?.ok === false ? 500 : 200).json(payload);
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/maintenance/run', async (request, response) => {
    try {
      if (!candidateTracker?.runMaintenance) {
        response.status(503).json({ ok: false, error: 'Candidate maintenance is unavailable' });
        return;
      }
      const payload = await candidateTracker.runMaintenance({
        force: optionalBoolean(request.query.force ?? request.body?.force, false),
        forceFetch: optionalBoolean(request.query.forceFetch ?? request.body?.forceFetch, true),
        forceScoring: optionalBoolean(request.query.forceScoring ?? request.body?.forceScoring, false),
      });
      if (!payload) {
        response.status(503).json({ ok: false, error: 'Candidate maintenance is disabled or already running' });
        return;
      }
      response.status(payload?.ok === false ? 500 : 200).json(payload);
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function optionalBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}
