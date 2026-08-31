/*
 * Vercel serverless entry point.
 *
 * Set this before importing server/index.js so the local Express listener is
 * not started inside a Vercel Function.
 */
process.env.SWOOP_AUTOSTART = 'false';

const { app } = await import('../server/index.js');

export default app;