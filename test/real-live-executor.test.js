import { describe, expect, it } from 'vitest';
import { createOrDeriveApiCredentials, redactedLiveConfigForDiagnostics } from '../server/real/live-executor.js';

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

  it('derives existing Polymarket API credentials before creating a new key', async () => {
    const calls = [];
    const creds = await createOrDeriveApiCredentials({
      createApiKey: async () => {
        calls.push('create');
        return { key: 'created', secret: 'created-secret', passphrase: 'created-passphrase' };
      },
      deriveApiKey: async () => {
        calls.push('derive');
        return { key: 'key', secret: 'secret', passphrase: 'passphrase' };
      },
    });

    expect(calls).toEqual(['derive']);
    expect(creds).toEqual({ key: 'key', secret: 'secret', passphrase: 'passphrase' });
  });

  it('creates Polymarket API credentials only when derive fails', async () => {
    const calls = [];
    const creds = await createOrDeriveApiCredentials({
      createApiKey: async () => {
        calls.push('create');
        return { key: 'key', secret: 'secret', passphrase: 'passphrase' };
      },
      deriveApiKey: async () => {
        calls.push('derive');
        throw new Error('Could not derive api key');
      },
    });

    expect(calls).toEqual(['derive', 'create']);
    expect(creds).toEqual({ key: 'key', secret: 'secret', passphrase: 'passphrase' });
  });

  it('surfaces both Polymarket API credential failures when create and derive fail', async () => {
    await expect(createOrDeriveApiCredentials({
      createApiKey: async () => {
        throw new Error('Could not create api key');
      },
      deriveApiKey: async () => {
        throw new Error('Could not derive api key');
      },
    })).rejects.toThrow('create: Could not create api key; derive: Could not derive api key');
  });
});
