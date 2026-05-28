import { describe, expect, it } from 'vitest';
import { redactedLiveConfigForDiagnostics } from '../server/real/live-executor.js';

const privateKey = `0x${'1'.repeat(64)}`;
const funderAddress = `0x${'2'.repeat(40)}`;

describe('real live executor diagnostics', () => {
  it('reports the Polygon RPC transport as configured for live signing', () => {
    const diagnostics = redactedLiveConfigForDiagnostics({
      privateKey,
      funderAddress,
      rpcUrl: 'https://polygon.example',
    });

    expect(diagnostics.ready).toBe(true);
    expect(diagnostics.rpcUrlConfigured).toBe(true);
    expect(diagnostics.missing).not.toContain('POLYGON_RPC_URL');
  });
});
