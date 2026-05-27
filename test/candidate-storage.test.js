import { describe, expect, it } from 'vitest';
import { seedActiveCopyPoolBackfill } from '../server/candidate-tracker/storage.js';

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
  });
});
