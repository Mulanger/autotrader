#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  CURATED_REAL_PORTFOLIO,
  CURATED_REAL_PORTFOLIO_NAME,
} from '../server/real/curated-portfolio.js';

const CONFIRMATION = 'CURATED_REAL_PORTFOLIO';

async function main() {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  await loadDotenv(path.resolve(cwd, args.envFile || '.env.local.worker'));

  const apply = Boolean(args.apply);
  if (apply && args.confirm !== CONFIRMATION) {
    throw new Error(`Applying requires --confirm ${CONFIRMATION}`);
  }

  const databaseUrl = args.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Set it in the environment, .env.local.worker, or pass --database-url.');
  }

  const desired = normalizePortfolio(CURATED_REAL_PORTFOLIO);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: shouldUseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  });

  try {
    const result = apply
      ? await applyPortfolio(pool, desired)
      : await previewPortfolio(pool, desired);
    printSummary({ ...result, apply });
  } finally {
    await pool.end();
  }
}

function normalizePortfolio(entries) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const wallet = normalizeWallet(entry.wallet);
    if (!wallet) throw new Error(`Invalid curated wallet: ${entry.wallet}`);
    if (seen.has(wallet)) throw new Error(`Duplicate curated wallet: ${wallet}`);
    seen.add(wallet);
    normalized.push({
      wallet,
      displayName: entry.displayName || null,
      pseudonym: entry.pseudonym || null,
      profileImage: entry.profileImage || null,
      reason: entry.reason || null,
      portfolioName: CURATED_REAL_PORTFOLIO_NAME,
    });
  }
  return normalized;
}

async function previewPortfolio(pool, desired) {
  const active = await readActiveFollows(pool);
  const existingByWallet = await readExistingFollows(pool, desired.map((entry) => entry.wallet));
  return summarizeDiff({ active, existingByWallet, desired });
}

async function applyPortfolio(pool, desired) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const active = await readActiveFollows(client, { lock: true });
    const existingByWallet = await readExistingFollows(client, desired.map((entry) => entry.wallet), { lock: true });
    const diff = summarizeDiff({ active, existingByWallet, desired });

    const desiredWallets = desired.map((entry) => entry.wallet);
    const removeResult = await client.query(
      `
        update real_followed_traders
        set status = 'removed', removed_at = now(), updated_at = now()
        where status = 'active'
          and not (lower(wallet) = any($1::text[]))
        returning *
      `,
      [desiredWallets]
    );

    for (const row of removeResult.rows) {
      await insertEvent(client, {
        wallet: row.wallet,
        action: 'removed',
        reason: `Portfolio sync removed wallet outside ${CURATED_REAL_PORTFOLIO_NAME}`,
        payload: mapFollowRow(row),
      });
    }

    for (const entry of desired) {
      const payload = {
        ...entry,
        source: 'curated_real_portfolio_sync',
      };
      const result = await client.query(
        `
          insert into real_followed_traders (
            wallet, display_name, pseudonym, profile_image, status, added_at, removed_at, payload, updated_at
          )
          values ($1, $2, $3, $4, 'active', now(), null, $5::jsonb, now())
          on conflict (wallet)
          do update set
            display_name = coalesce(excluded.display_name, real_followed_traders.display_name),
            pseudonym = coalesce(excluded.pseudonym, real_followed_traders.pseudonym),
            profile_image = coalesce(excluded.profile_image, real_followed_traders.profile_image),
            status = 'active',
            added_at = case
              when real_followed_traders.status = 'active' then real_followed_traders.added_at
              else now()
            end,
            removed_at = null,
            payload = excluded.payload,
            updated_at = now()
          returning *
        `,
        [
          entry.wallet,
          entry.displayName,
          entry.pseudonym,
          entry.profileImage,
          JSON.stringify(payload),
        ]
      );
      const row = result.rows[0];
      const wasActive = existingByWallet.get(entry.wallet)?.status === 'active';
      if (!wasActive) {
        await insertEvent(client, {
          wallet: row.wallet,
          action: 'followed',
          reason: `Portfolio sync added wallet to ${CURATED_REAL_PORTFOLIO_NAME}`,
          payload: mapFollowRow(row),
        });
      }
    }

    await client.query('commit');
    return diff;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function summarizeDiff({ active, existingByWallet, desired }) {
  const desiredByWallet = new Map(desired.map((entry) => [entry.wallet, entry]));
  const activeByWallet = new Map(active.map((entry) => [entry.wallet, entry]));
  const keep = [];
  const add = [];
  const reactivate = [];
  const remove = [];

  for (const entry of desired) {
    if (activeByWallet.has(entry.wallet)) {
      keep.push({ ...entry, current: activeByWallet.get(entry.wallet) });
    } else if (existingByWallet.has(entry.wallet)) {
      reactivate.push({ ...entry, current: existingByWallet.get(entry.wallet) });
    } else {
      add.push(entry);
    }
  }

  for (const entry of active) {
    if (!desiredByWallet.has(entry.wallet)) remove.push(entry);
  }

  return {
    portfolioName: CURATED_REAL_PORTFOLIO_NAME,
    currentActiveCount: active.length,
    desiredCount: desired.length,
    keep,
    add,
    reactivate,
    remove,
    finalActiveCount: desired.length,
  };
}

async function readActiveFollows(clientOrPool, { lock = false } = {}) {
  const result = await clientOrPool.query(
    `
      select *
      from real_followed_traders
      where status = 'active'
      order by added_at asc nulls last
      ${lock ? 'for update' : ''}
    `
  );
  return result.rows.map(mapFollowRow);
}

async function readExistingFollows(clientOrPool, wallets, { lock = false } = {}) {
  if (!wallets.length) return new Map();
  const result = await clientOrPool.query(
    `
      select *
      from real_followed_traders
      where lower(wallet) = any($1::text[])
      ${lock ? 'for update' : ''}
    `,
    [wallets]
  );
  return new Map(result.rows.map((row) => [normalizeWallet(row.wallet), mapFollowRow(row)]));
}

async function insertEvent(client, { wallet, action, reason, payload }) {
  await client.query(
    `
      insert into real_events (wallet, action, reason, payload)
      values ($1, $2, $3, $4::jsonb)
    `,
    [wallet, action, reason, JSON.stringify(payload || {})]
  );
}

function mapFollowRow(row) {
  return {
    wallet: normalizeWallet(row.wallet),
    displayName: row.display_name || null,
    pseudonym: row.pseudonym || null,
    profileImage: row.profile_image || null,
    status: row.status,
    addedAt: row.added_at ? new Date(row.added_at).toISOString() : null,
    removedAt: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function printSummary(result) {
  console.log(`${result.apply ? 'APPLY' : 'DRY RUN'} portfolio sync: ${result.portfolioName}`);
  console.log(`Current active follows: ${result.currentActiveCount}`);
  console.log(`Desired active follows: ${result.desiredCount}`);
  console.log(`Final active follows: ${result.finalActiveCount}`);
  console.log('');
  printGroup('Keep active', result.keep);
  printGroup('Add new', result.add);
  printGroup('Reactivate', result.reactivate);
  printGroup('Remove', result.remove);
  if (!result.apply) {
    console.log('');
    console.log(`No database changes were made. Apply with: node scripts/sync-real-portfolio.js --apply --confirm ${CONFIRMATION}`);
  }
}

function printGroup(label, rows) {
  console.log(`${label}: ${rows.length}`);
  for (const row of rows) {
    console.log(`  - ${row.wallet} ${row.displayName || row.pseudonym || ''}`.trimEnd());
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--apply') parsed.apply = true;
    else if (arg === '--env-file') parsed.envFile = requireValue(argv, ++index, arg);
    else if (arg === '--database-url') parsed.databaseUrl = requireValue(argv, ++index, arg);
    else if (arg === '--confirm') parsed.confirm = requireValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function loadDotenv(envPath) {
  let content;
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function normalizeWallet(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(text) ? text : null;
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return !/localhost|127\.0\.0\.1/i.test(databaseUrl);
}

function printHelp() {
  console.log(`
Usage:
  node scripts/sync-real-portfolio.js [options]

Options:
  --env-file <path>       Env file to read first (default: .env.local.worker)
  --database-url <url>    Override DATABASE_URL
  --apply                 Apply the portfolio sync. Omit for dry-run.
  --confirm <text>        Required with --apply: ${CONFIRMATION}
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
