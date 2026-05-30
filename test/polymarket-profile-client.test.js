import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPolymarketProfileStats } from '../server/polymarket-profile-client.js';

const wallet = '0x531b33c5e7b8c2610917f883a13a1b8b1a706022';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('polymarket profile client', () => {
  it('normalizes current Polymarket profile stats for a wallet', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/v1/leaderboard')) {
        return jsonResponse([{
          rank: '2675266',
          proxyWallet: wallet,
          userName: 'dr-esin',
          vol: 1526293.61343,
          pnl: -1388.6384998459325,
          profileImage: '',
        }]);
      }
      if (text.includes('/public-profile')) {
        return jsonResponse({
          proxyWallet: wallet,
          name: 'dr-esin',
          pseudonym: 'Corrupt-Closure',
          profileImage: 'https://example.com/avatar.png',
        });
      }
      if (text.includes('/traded')) {
        return jsonResponse({ user: wallet, traded: 10 });
      }
      throw new Error(`Unexpected URL: ${text}`);
    });

    const row = await fetchPolymarketProfileStats(wallet, { retries: 0 });

    expect(row.proxyWallet).toBe(wallet);
    expect(row.displayName).toBe('dr-esin');
    expect(row.pseudonym).toBe('Corrupt-Closure');
    expect(row.rank).toBe(2675266);
    expect(row.allTimeProfitUsd).toBeCloseTo(-1388.6385, 4);
    expect(row.allTimeVolumeUsd).toBeCloseTo(1526293.61343, 4);
    expect(row.allTimeMarketsTraded).toBe(10);
    expect(row.allTimeWinRatePct).toBeNull();
    expect(row.profileStatsSource).toBe('polymarket');
  });

  it('clears stale P/L fields when Polymarket returns no leaderboard row', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const text = String(url);
      if (text.includes('/v1/leaderboard')) return jsonResponse([]);
      if (text.includes('/public-profile')) return jsonResponse({ proxyWallet: wallet, name: 'dr-esin' });
      if (text.includes('/traded')) return jsonResponse({ user: wallet, traded: 0 });
      throw new Error(`Unexpected URL: ${text}`);
    });

    const row = await fetchPolymarketProfileStats(wallet, { retries: 0 });

    expect(row.allTimeProfitUsd).toBeNull();
    expect(row.allTimeVolumeUsd).toBeNull();
    expect(row.allTimeWinRatePct).toBeNull();
    expect(row.allTimeMarketsTraded).toBe(0);
  });
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
