import { Pool } from 'pg';
import { serializeDurableState } from './app-state.js';
import { nowIso } from './format.js';

const STATE_KEY = 'default';

export async function createStorage(state) {
  const info = state.service.storage;

  if (!process.env.DATABASE_URL) {
    info.mode = 'memory';
    info.status = 'memory_only';
    info.durable = false;
    return {
      info,
      load: async () => null,
      queueSave: () => {},
      close: async () => {},
    };
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  });

  try {
    await pool.query(`
      create table if not exists autotrader_state (
        key text primary key,
        payload jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    info.mode = 'postgres';
    info.status = 'ready';
    info.durable = true;
  } catch (error) {
    info.mode = 'postgres';
    info.status = 'error';
    info.durable = false;
    info.lastError = error.message;
    throw error;
  }

  let queuedPayload = null;
  let saveRunning = false;

  async function load() {
    try {
      const result = await pool.query('select payload from autotrader_state where key = $1', [STATE_KEY]);
      info.lastLoadedAt = nowIso();
      info.status = 'ready';
      info.lastError = null;
      return result.rows[0]?.payload || null;
    } catch (error) {
      info.status = 'error';
      info.lastError = error.message;
      return null;
    }
  }

  async function queueSave(appState) {
    queuedPayload = serializeDurableState(appState);
    if (saveRunning) return;

    saveRunning = true;
    while (queuedPayload) {
      const payload = queuedPayload;
      queuedPayload = null;
      try {
        info.status = 'saving';
        await pool.query(
          `
            insert into autotrader_state (key, payload, updated_at)
            values ($1, $2::jsonb, now())
            on conflict (key)
            do update set payload = excluded.payload, updated_at = now()
          `,
          [STATE_KEY, JSON.stringify(payload)]
        );
        info.status = 'ready';
        info.lastSavedAt = nowIso();
        info.lastError = null;
      } catch (error) {
        info.status = 'error';
        info.lastError = error.message;
      }
    }
    saveRunning = false;
  }

  return {
    info,
    load,
    queueSave,
    close: () => pool.end(),
  };
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.PGSSLMODE === 'require') return true;
  return /sslmode=require/i.test(databaseUrl);
}
