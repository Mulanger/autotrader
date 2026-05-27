import { describe, expect, it } from 'vitest';
import { createAppState } from '../server/app-state.js';
import { assertPin, createRealTraderService } from '../server/real/service.js';
import { createMemoryRealStorage } from '../server/real/storage.js';

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function rawTrade({ timestamp, price = 0.5, asset = 'token-1', tx = '0x1' } = {}) {
  return {
    proxyWallet: wallet,
    side: 'BUY',
    asset,
    size: 100,
    price,
    timestamp,
    title: 'Market',
    outcome: 'YES',
    transactionHash: tx,
  };
}

describe('real trader service', () => {
  it('validates the server-side real action PIN', () => {
    expect(() => assertPin('1993')).not.toThrow();
    expect(() => assertPin('0000')).toThrow('Invalid real action PIN');
  });

  it('ignores historical trades before added_at and records new dry-run attempts', async () => {
    const state = createAppState();
    const storage = createMemoryRealStorage();
    await storage.followTrader({ wallet });
    const follow = (await storage.listActiveFollows())[0];
    const addedSeconds = Math.floor(Date.parse(follow.addedAt) / 1000);

    const service = createRealTraderService(state, () => {}, {
      autoRun: false,
      storageFactory: async () => storage,
      fetchRealFollowTrades: async () => [
        rawTrade({ timestamp: addedSeconds - 60, tx: '0xold' }),
        rawTrade({ timestamp: addedSeconds + 60, tx: '0xnew' }),
      ],
      fetchOrderBook: async () => ({ asks: [{ price: '0.51', size: '100' }] }),
      fetchGammaResolution: async () => null,
    });

    await service.start();
    const result = await service.runPoll();
    const real = await service.getState();

    expect(result.checked).toBe(1);
    expect(real.orders).toHaveLength(1);
    expect(real.orders[0].status).toBe('would_fill');
    await service.close();
  });

  it('records missing_token rejects when no token can be resolved', async () => {
    const state = createAppState();
    const storage = createMemoryRealStorage();
    await storage.followTrader({ wallet });
    const follow = (await storage.listActiveFollows())[0];
    const addedSeconds = Math.floor(Date.parse(follow.addedAt) / 1000);
    const service = createRealTraderService(state, () => {}, {
      autoRun: false,
      storageFactory: async () => storage,
      fetchRealFollowTrades: async () => [rawTrade({ timestamp: addedSeconds + 60, asset: null })],
      fetchClobMarketInfo: async () => null,
      fetchOrderBook: async () => {
        throw new Error('should not fetch without token');
      },
      fetchGammaResolution: async () => null,
    });

    await service.start();
    await service.runPoll();
    const real = await service.getState();

    expect(real.orders[0].status).toBe('rejected');
    expect(real.orders[0].reasonCode).toBe('missing_token');
    await service.close();
  });
});
