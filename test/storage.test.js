import { describe, expect, it } from 'vitest';
import { createRetryingSaveQueue } from '../server/storage.js';

function waitForMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('storage save queue', () => {
  it('keeps a failed save payload queued and retries it', async () => {
    const info = {};
    const retryCallbacks = [];
    const saved = [];
    let attempts = 0;
    const queue = createRetryingSaveQueue({
      info,
      serialize: (state) => ({ ...state }),
      save: async (payload) => {
        attempts += 1;
        if (attempts === 1) throw new Error('database unavailable');
        saved.push(payload);
      },
      schedule: (callback) => {
        retryCallbacks.push(callback);
        return callback;
      },
      cancel: () => {},
      retryBaseMs: 1,
    });

    queue.queueSave({ version: 1 });
    await waitForMicrotasks();

    expect(queue.queued).toBe(true);
    expect(info.status).toBe('error');
    expect(info.saveFailureCount).toBe(1);
    expect(retryCallbacks).toHaveLength(1);

    retryCallbacks[0]();
    await waitForMicrotasks();

    expect(queue.queued).toBe(false);
    expect(info.status).toBe('ready');
    expect(info.consecutiveSaveFailures).toBe(0);
    expect(saved).toEqual([{ version: 1 }]);
  });
});
