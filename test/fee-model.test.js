import { describe, expect, it } from 'vitest';
import { buildEntryFeeModel } from '../server/fee-model.js';

describe('fee model', () => {
  it('marks fees unknown when no upstream fee data is available', () => {
    const fee = buildEntryFeeModel({}, { priceCents: 50, shares: 20 });

    expect(fee.status).toBe('unknown');
    expect(fee.entryFeeUsd).toBeNull();
    expect(fee.netShares).toBe(20);
  });

  it('estimates taker buy fees from fee rate bps when fees are enabled', () => {
    const fee = buildEntryFeeModel(
      { fees: { feesEnabled: true, feeRateBps: 300 } },
      { priceCents: 50, shares: 20 }
    );

    expect(fee.status).toBe('estimated');
    expect(fee.entryFeeUsd).toBe(0.15);
    expect(fee.feeShares).toBe(0.3);
    expect(fee.netShares).toBe(19.7);
  });

  it('uses zero fee when upstream says fees are disabled', () => {
    const fee = buildEntryFeeModel(
      { fees: { feesEnabled: false } },
      { priceCents: 50, shares: 20 }
    );

    expect(fee.status).toBe('known');
    expect(fee.entryFeeUsd).toBe(0);
    expect(fee.netShares).toBe(20);
  });
});
