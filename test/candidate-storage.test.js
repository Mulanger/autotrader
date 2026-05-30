import { describe, expect, it } from 'vitest';
import { getMaintenanceWallets, seedActiveCopyPoolBackfill } from '../server/candidate-tracker/storage.js';

describe('candidate storage helpers', () => {
  it('seeds missing active copy-pool wallets and requeues shallow completed backfills', async () => {
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ wallet: '0xaaa' }] };
      },
    };

    const inserted = await seedActiveCopyPoolBackfill(pool, [' 0xAAA ', '0xbbb', '0xaaa']);

    expect(inserted).toEqual(['0xaaa']);
    expect(calls[0].params[0]).toEqual(['0xaaa', '0xbbb']);
    expect(calls[0].params[1]).toBe(30);
    expect(calls[0].sql).toMatch(/where status = 'active'/i);
    expect(calls[0].sql).toMatch(/on conflict \(wallet\) do update set/i);
    expect(calls[0].sql).toMatch(/backfilled_since > now\(\) - \(\$2::integer \* interval '1 day'\)/i);
    expect(calls[0].sql).toMatch(/configured max is 3000/i);
  });

  it('builds active scored maintenance wallet scope from active copy pool, scores, and baselines', async () => {
    const calls = [];
    const pool = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ wallet: '0xaaa' }, { wallet: '0xbbb' }] };
      },
    };

    const wallets = await getMaintenanceWallets(pool, {
      scope: 'active_scored',
      baselineWallets: [' 0xAAA ', '0xccc', '0xaaa'],
      limit: 500,
    });

    expect(wallets).toEqual(['0xaaa', '0xbbb']);
    expect(calls[0].params).toEqual(['active_scored', ['0xaaa', '0xccc'], 500]);
    expect(calls[0].sql).toMatch(/from copy_pool_traders/i);
    expect(calls[0].sql).toMatch(/status = 'active'/i);
    expect(calls[0].sql).toMatch(/from real_copy_quality_scores/i);
    expect(calls[0].sql).toMatch(/from unnest\(\$2::text\[\]\)/i);
  });
});
