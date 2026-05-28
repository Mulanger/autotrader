import { AssetType, ClobClient, OrderType, Side, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { POLYGON_RPC_URL, POLYMARKET_CLOB_URL } from '../config.js';

const DEFAULT_CHAIN_ID = 137;
const PUSD_COLLATERAL_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const PUBLIC_POLYGON_RPC_URLS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://1rpc.io/matic',
];
const COLLATERAL_ALLOWANCE_SPENDERS = [
  ['ctfExchange', '0xE111180000d2663C0091e4f400237545B87B996B'],
  ['negRiskAdapter', '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'],
  ['negRiskExchange', '0xe2222d279d744050d28e00520010520000310F59'],
];

export function createPolymarketLiveExecutor(options = {}) {
  const config = readLiveConfig(options);
  let clientPromise = null;
  let balanceAllowanceSynced = false;

  return {
    getReadiness: () => publicReadiness(config),
    getAccountSnapshot,
    async executeFokBuy({ attempt }) {
      const readiness = publicReadiness(config);
      if (!readiness.ready) {
        throw new Error(`Live trading is not configured: missing ${readiness.missing.join(', ')}`);
      }
      if (!attempt?.asset) throw new Error('Cannot submit live order without a token id');

      const client = await getClient();
      await ensureBalanceAllowanceSynced(client);
      const tickSize = tickSizeString(attempt.tickSize);
      const priceLimit = liveBuyPriceLimit(attempt, tickSize);
      const order = {
        tokenID: attempt.asset,
        amount: Number(attempt.stakeUsd),
        side: Side.BUY,
        orderType: OrderType.FOK,
        price: priceLimit,
      };
      if (config.builderCode) order.builderCode = config.builderCode;

      const response = await client.createAndPostMarketOrder(
        order,
        {
          tickSize,
          negRisk: Boolean(attempt.negRisk),
        },
        OrderType.FOK
      );

      if (response?.success === false || response?.error || response?.errorMsg) {
        return {
          status: 'rejected',
          dryRun: false,
          liveExecution: true,
          reasonCode: 'live_order_rejected',
          reason: response.errorMsg || response.error || 'Polymarket rejected the live FOK order',
          clobResponse: response,
        };
      }

      return {
        status: 'filled',
        dryRun: false,
        liveExecution: true,
        reasonCode: null,
        reason: 'Live FOK BUY accepted by Polymarket',
        clobOrderId: response?.orderID || response?.orderId || response?.id || null,
        clobStatus: response?.status || null,
        clobTradeIds: response?.tradeIDs || response?.tradeIds || [],
        clobTransactionHashes: response?.transactionsHashes || response?.transactionHashes || [],
        clobResponse: response,
      };
    },
  };

  async function getClient() {
    if (!clientPromise) {
      clientPromise = createClient(config).catch((error) => {
        clientPromise = null;
        throw error;
      });
    }
    return clientPromise;
  }

  async function ensureBalanceAllowanceSynced(client) {
    if (balanceAllowanceSynced || typeof client.updateBalanceAllowance !== 'function') return;
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    balanceAllowanceSynced = true;
  }

  async function getAccountSnapshot() {
    const checkedAt = new Date().toISOString();
    const readiness = publicReadiness(config);
    const safeConfig = safeAccountConfig(config);
    const onchainCollateral = await config.collateralReader(config);
    if (!readiness.ready) {
      return {
        ok: false,
        status: 'not_configured',
        checkedAt,
        ...safeConfig,
        missing: readiness.missing,
        collateral: mergeCollateralSnapshots(null, onchainCollateral),
        lastError: null,
      };
    }

    try {
      const client = await getClient();
      await ensureBalanceAllowanceSynced(client);
      const collateral = typeof client.getBalanceAllowance === 'function'
        ? await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
        : null;
      return {
        ok: true,
        status: 'ready',
        checkedAt,
        ...safeConfig,
        missing: [],
        collateral: mergeCollateralSnapshots(normalizeBalanceAllowance(collateral), onchainCollateral),
        lastError: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        checkedAt,
        ...safeConfig,
        missing: [],
        collateral: mergeCollateralSnapshots(null, onchainCollateral),
        lastError: formatCredentialError(error),
      };
    }
  }
}

function readLiveConfig(options) {
  const privateKey = options.privateKey || process.env.POLYMARKET_PRIVATE_KEY || '';
  const funderAddress =
    options.funderAddress ||
    process.env.POLYMARKET_FUNDER_ADDRESS ||
    process.env.POLYMARKET_DEPOSIT_WALLET_ADDRESS ||
    process.env.DEPOSIT_WALLET_ADDRESS ||
    '';
  const creds = normalizeCreds(options.creds || {
    key: process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY || '',
    secret: process.env.POLYMARKET_API_SECRET || process.env.CLOB_SECRET || '',
    passphrase: process.env.POLYMARKET_API_PASSPHRASE || process.env.CLOB_PASS_PHRASE || '',
  });
  return {
    host: options.host || POLYMARKET_CLOB_URL,
    chainId: Number(options.chainId || process.env.POLYMARKET_CHAIN_ID || DEFAULT_CHAIN_ID),
    rpcUrl: options.rpcUrl || POLYGON_RPC_URL,
    privateKey,
    funderAddress,
    signatureType: normalizeSignatureType(options.signatureType || process.env.POLYMARKET_SIGNATURE_TYPE || '3'),
    creds,
    builderCode: normalizeBytes32(options.builderCode || process.env.POLYMARKET_BUILDER_CODE || ''),
    clientFactory: options.clientFactory || ((clientOptions) => new ClobClient(clientOptions)),
    collateralReader: options.collateralReader || readOnchainCollateral,
  };
}

async function createClient(config) {
  const account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
  const signer = createWalletClient({ account, transport: http(config.rpcUrl) });
  const base = {
    host: config.host,
    chain: config.chainId,
    signer,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    throwOnError: true,
    retryOnError: true,
  };
  const creds = config.creds || await createOrDeriveApiCredentials(config.clientFactory(base));
  return config.clientFactory({ ...base, creds });
}

export async function createOrDeriveApiCredentials(authClient) {
  const derived = await attemptApiCredentialStep('derive', () => authClient.deriveApiKey());
  if (derived.creds?.key) return derived.creds;

  const created = await attemptApiCredentialStep('create', () => authClient.createApiKey());
  if (created.creds?.key) return created.creds;

  const reasons = [created, derived]
    .filter((result) => result.error)
    .map((result) => `${result.step}: ${result.error}`)
    .join('; ');
  throw new Error(`Could not create or derive Polymarket API key${reasons ? ` (${reasons})` : ''}`);
}

async function attemptApiCredentialStep(step, fn) {
  try {
    const creds = await fn();
    if (creds?.key && creds?.secret && creds?.passphrase) return { step, creds };
    return { step, error: 'response did not include key, secret, and passphrase' };
  } catch (error) {
    return { step, error: formatCredentialError(error) };
  }
}

function formatCredentialError(error) {
  const data = error?.data?.error || error?.data;
  if (typeof data === 'string') return data;
  if (data) return JSON.stringify(data);
  return String(error?.message || error || 'unknown error');
}

function publicReadiness(config) {
  const missing = [];
  if (!config.privateKey) missing.push('POLYMARKET_PRIVATE_KEY');
  if (!config.funderAddress) missing.push('POLYMARKET_FUNDER_ADDRESS');
  if (!Number.isFinite(config.chainId)) missing.push('POLYMARKET_CHAIN_ID');
  if (!config.rpcUrl) missing.push('POLYGON_RPC_URL');
  return {
    ready: missing.length === 0,
    missing,
    host: config.host,
    chainId: config.chainId,
    rpcUrlConfigured: Boolean(config.rpcUrl),
    signatureType: config.signatureType,
    funderAddressConfigured: Boolean(config.funderAddress),
    apiCredentialsConfigured: Boolean(config.creds),
    apiCredentialsWillDerive: !config.creds,
    builderCodeConfigured: Boolean(config.builderCode),
  };
}

function safeAccountConfig(config) {
  let signerAddress = null;
  try {
    signerAddress = config.privateKey ? privateKeyToAccount(normalizePrivateKey(config.privateKey)).address : null;
  } catch {
    signerAddress = null;
  }
  return {
    signerAddress,
    funderAddress: config.funderAddress || null,
    signatureType: config.signatureType,
    chainId: config.chainId,
    clobHost: config.host,
    rpcUrlConfigured: Boolean(config.rpcUrl),
    apiCredentialsConfigured: Boolean(config.creds),
    apiCredentialsWillDerive: !config.creds,
    builderCodeConfigured: Boolean(config.builderCode),
  };
}

export function normalizeBalanceAllowance(balanceAllowance) {
  if (!balanceAllowance || typeof balanceAllowance !== 'object') {
    return {
      rawBalance: null,
      balanceUsd: null,
      allowances: {},
      positiveAllowanceCount: 0,
      allAllowancesPositive: null,
    };
  }

  const allowanceSource = balanceAllowance.allowances || balanceAllowance.allowance || {};
  const allowances = Object.fromEntries(
    Object.entries(allowanceSource || {}).map(([key, value]) => [
      key,
      {
        raw: value === null || value === undefined ? null : String(value),
        valueUsd: parseClobUsd(value),
      },
    ])
  );
  const allowanceValues = Object.values(allowances)
    .map((entry) => entry.valueUsd)
    .filter(Number.isFinite);
  const balance = balanceAllowance.balance ?? balanceAllowance.collateralBalance ?? balanceAllowance.usdcBalance;
  return {
    rawBalance: balance === null || balance === undefined ? null : String(balance),
    balanceUsd: parseClobUsd(balance),
    source: 'clob_balance_allowance',
    allowances,
    positiveAllowanceCount: allowanceValues.filter((value) => value > 0).length,
    allAllowancesPositive: allowanceValues.length ? allowanceValues.every((value) => value > 0) : null,
  };
}

function mergeCollateralSnapshots(clobCollateral, onchainCollateral) {
  const base = clobCollateral || normalizeBalanceAllowance(null);
  return {
    ...base,
    asset: 'pUSD',
    tokenAddress: PUSD_COLLATERAL_ADDRESS,
    walletAddress: onchainCollateral?.walletAddress || null,
    walletBalanceRaw: onchainCollateral?.rawBalance ?? null,
    walletBalanceUsd: onchainCollateral?.balanceUsd ?? null,
    walletBalanceSource: onchainCollateral?.source || 'polygon_pusd_onchain',
    walletBalanceError: onchainCollateral?.error || null,
    onchainAllowances: onchainCollateral?.allowances || {},
    onchainPositiveAllowanceCount: onchainCollateral?.positiveAllowanceCount ?? 0,
    onchainAllAllowancesPositive: onchainCollateral?.allAllowancesPositive ?? null,
  };
}

async function readOnchainCollateral(config) {
  const walletAddress = config.funderAddress || null;
  const base = {
    source: 'polygon_pusd_onchain',
    asset: 'pUSD',
    tokenAddress: PUSD_COLLATERAL_ADDRESS,
    walletAddress,
    checkedAt: new Date().toISOString(),
  };
  if (!walletAddress) {
    return {
      ...base,
      rawBalance: null,
      balanceUsd: null,
      allowances: {},
      positiveAllowanceCount: 0,
      allAllowancesPositive: null,
      error: 'Missing funder wallet',
    };
  }

  const errors = [];
  for (const rpcUrl of rpcCandidates(config.rpcUrl)) {
    try {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const rawBalance = await publicClient.readContract({
        address: PUSD_COLLATERAL_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddress],
      });
      const allowanceEntries = await Promise.all(COLLATERAL_ALLOWANCE_SPENDERS.map(async ([name, spender]) => {
        const rawAllowance = await publicClient.readContract({
          address: PUSD_COLLATERAL_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [walletAddress, spender],
        });
        return [
          name,
          {
            spender,
            raw: rawAllowance.toString(),
            valueUsd: Number(formatUnits(rawAllowance, 6)),
            healthy: rawAllowance > 0n,
          },
        ];
      }));
      const allowances = Object.fromEntries(allowanceEntries);
      const allowanceValues = Object.values(allowances);
      return {
        ...base,
        rawBalance: rawBalance.toString(),
        balanceUsd: Number(formatUnits(rawBalance, 6)),
        allowances,
        positiveAllowanceCount: allowanceValues.filter((entry) => entry.healthy).length,
        allAllowancesPositive: allowanceValues.length ? allowanceValues.every((entry) => entry.healthy) : null,
        error: null,
      };
    } catch (error) {
      errors.push(formatCredentialError(error));
    }
  }

  return {
    ...base,
    rawBalance: null,
    balanceUsd: null,
    allowances: {},
    positiveAllowanceCount: 0,
    allAllowancesPositive: null,
    error: errors[0] || 'Could not read pUSD balance on Polygon',
  };
}

function rpcCandidates(primary) {
  return [...new Set([primary, ...PUBLIC_POLYGON_RPC_URLS].filter(Boolean))];
}

function parseClobUsd(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (Number.isInteger(number) && Math.abs(number) >= 100_000) return number / 1_000_000;
  return number;
}

function normalizeCreds(creds) {
  const key = String(creds?.key || '').trim();
  const secret = String(creds?.secret || '').trim();
  const passphrase = String(creds?.passphrase || '').trim();
  if (!key && !secret && !passphrase) return null;
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

function normalizeSignatureType(value) {
  const number = Number(value);
  if (number === 0) return SignatureTypeV2.EOA;
  if (number === 1) return SignatureTypeV2.POLY_PROXY;
  if (number === 2) return SignatureTypeV2.POLY_GNOSIS_SAFE;
  return SignatureTypeV2.POLY_1271;
}

function normalizePrivateKey(value) {
  const text = String(value || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return `0x${text}`;
  throw new Error('POLYMARKET_PRIVATE_KEY must be a 32-byte hex private key');
}

function normalizeBytes32(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text;
  return null;
}

function tickSizeString(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '0.01';
  return trimDecimal(number);
}

function liveBuyPriceLimit(attempt, tickSize) {
  const fallback = Number(attempt.worstAskCents ?? attempt.bestAskCents ?? attempt.sourcePriceCents) / 100;
  const max = Number(attempt.maxGuardCents) / 100;
  const rawLimit = Number.isFinite(max) && max > 0 ? max : fallback;
  const tick = Number(tickSize) || 0.01;
  const floored = Math.floor((rawLimit + Number.EPSILON) / tick) * tick;
  return Number(trimDecimal(Math.max(tick, floored)));
}

function trimDecimal(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

export function redactedLiveConfigForDiagnostics(options = {}) {
  return publicReadiness(readLiveConfig(options));
}
