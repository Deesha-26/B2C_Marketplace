import { createPostgres } from './postgres.js';

/**
 * Supabase PostgreSQL only. The SQLite driver and the dual-dialect translator
 * were deleted: they existed to run legacy tests, not to serve the product.
 */
export async function open(opts = {}) {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set — point it at the Supabase transaction pooler (port 6543)');
  return createPostgres(url);
}

/**
 * PostgreSQL raises 23505 for a unique violation.
 *
 * A bare code check is dangerous: an unrelated constraint failing elsewhere in
 * the same statement would be silently read as "already done" and the caller
 * would report success for work that never happened. Callers therefore name the
 * constraint they expect, and anything else propagates.
 */
export const isUniqueViolation = (err, expectedConstraint) => {
  if (err?.code !== '23505') return false;
  if (!expectedConstraint) return true;          // only for deliberate broad use
  return err.constraint === expectedConstraint;
};

export const now = () => new Date().toISOString();
export const uid = p => `${p}_${Math.random().toString(36).slice(2, 12)}`;
