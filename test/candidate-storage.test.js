import { describe, expect, it } from 'vitest';
import { seedActiveCopyPoolBackfill } from '../server/candidate-tracker/storage.js';

describe('candidate storage helpers', () => {
  it('seeds missing active copy-pool wallets without requeueing existing traders', async () => {
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
    expect(calls[0].sql).toMatch(/where status = 'active'/i);
    expect(calls[0].sql).toMatch(/on conflict \(wallet\) do nothing/i);
  });
});
