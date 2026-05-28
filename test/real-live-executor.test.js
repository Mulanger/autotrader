import { describe, expect, it } from 'vitest';
import {
  createOrDeriveApiCredentials,
  createPolymarketLiveExecutor,
  redactedLiveConfigForDiagnostics,
} from '../server/real/live-executor.js';

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

  it('returns account metadata and CLOB balance details without credential secrets', async () => {
    const executor = createPolymarketLiveExecutor({
      privateKey,
      funderAddress,
      rpcUrl: 'https://polygon.example',
      creds: { key: 'api-key', secret: 'api-secret', passphrase: 'api-passphrase' },
      clientFactory: () => ({
        updateBalanceAllowance: async () => {},
        getBalanceAllowance: async () => ({
          balance: '12340000',
          allowances: {
            collateral: '1000000',
            conditional: '2000000',
          },
        }),
      }),
    });

    const snapshot = await executor.getAccountSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.ok).toBe(true);
    expect(snapshot.signerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(snapshot.funderAddress).toBe(funderAddress);
    expect(snapshot.chainId).toBe(137);
    expect(snapshot.collateral.balanceUsd).toBeCloseTo(12.34);
    expect(snapshot.collateral.positiveAllowanceCount).toBe(2);
    expect(serialized).not.toContain(privateKey.slice(2));
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('api-passphrase');
  });
});
