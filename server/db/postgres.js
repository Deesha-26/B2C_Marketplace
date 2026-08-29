import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Postgres driver (Supabase in production).
 *
 * Use the TRANSACTION POOLER connection string (port 6543), not the direct one
 * (5432): serverless opens a connection per cold start and would otherwise
 * exhaust the server. The pooler forbids prepared statements, which is why no
 * query here is ever given a `name` — node-postgres only prepares named ones.
 */
export async function createPostgres(connectionString, { migrate, searchPath } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  /**
   * Transaction pooling (port 6543) hands out a different server connection per
   * transaction, so a session-level `SET search_path` does not survive. Every
   * statement therefore runs inside a transaction that sets it with SET LOCAL.
   * Test-only: production uses the default schema and skips this entirely.
   */
  const applyPath = async client => {
    if (searchPath) await client.query(`SET LOCAL search_path TO ${searchPath}`);
  };

  const api = client => ({
    dialect: 'postgres',
    async query(sql, params = []) { return (await client.query(sql, params)).rows; },
    async one(sql, params = []) { return (await client.query(sql, params)).rows[0] ?? null; },
    async all(sql, params = []) { return (await client.query(sql, params)).rows; },
    async none(sql, params = []) { await client.query(sql, params); },
    async transaction(fn) { return fn(api(client)); },   // already inside one
    async close() {},
  });

  /** Single statement, wrapped only when a search_path must be applied. */
  const run = async (sql, params) => {
    if (!searchPath) return (await pool.query(sql, params)).rows;
    return root.transaction(async t => t.query(sql, params));
  };

  const root = {
    dialect: 'postgres',
    async query(sql, params = []) { return run(sql, params); },
    async one(sql, params = []) { return (await run(sql, params))[0] ?? null; },
    async all(sql, params = []) { return run(sql, params); },
    async none(sql, params = []) { await run(sql, params); },

    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await applyPath(client);
        const out = await fn(api(client));
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };

  // Idempotent: every statement in schema.sql is CREATE ... IF NOT EXISTS.
  const shouldMigrate = migrate ?? (process.env.DB_MIGRATE !== 'false');
  if (shouldMigrate) {
    await root.none(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  }
  return root;
}
