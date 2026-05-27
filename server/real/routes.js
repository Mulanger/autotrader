import express from 'express';

export function createRealRoutes(realService) {
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

  return router;
}

function statusCode(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  return 500;
}
