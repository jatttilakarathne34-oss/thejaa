'use strict';
// PostgreSQL everywhere:
//  - production (Vercel): Neon Postgres through DATABASE_URL
//  - local dev / tests: embedded PostgreSQL (PGlite), stored in ./data/pgdata (or in memory for tests)
// SQL uses @name (object) or ? (array) placeholders; they are converted to $1, $2…
function convert(sql, params) {
  if (params === undefined || Array.isArray(params)) { let i = 0; return { text: sql.replace(/\?/g, () => '$' + (++i)), values: params || [] }; }
  const names = [], values = [];
  const text = sql.replace(/@(\w+)/g, (m, n) => { let k = names.indexOf(n); if (k < 0) { names.push(n); values.push(params[n]); k = names.length - 1; } return '$' + (k + 1); });
  return { text, values };
}
const clean = v => (v === undefined ? null : v);
function api(raw) {
  const run = async (sql, p) => { const { text, values } = convert(sql, p); const r = await raw.run(text, values.map(clean)); return { rows: r.rows, count: r.rowCount ?? r.affectedRows ?? 0 }; };
  return { run, all: async (s, p) => (await run(s, p)).rows, get: async (s, p) => (await run(s, p)).rows[0], exec: s => raw.exec(s) };
}
async function createDb() {
  let raw;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: +process.env.PG_POOL_MAX || 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
    pool.on('error', e => console.error('pg pool error:', e.message));
    raw = {
      run: (t, v) => pool.query(t, v), exec: s => pool.query(s),
      tx: async fn => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn({ run: (t, v) => c.query(t, v), exec: s => c.query(s) }); await c.query('COMMIT'); return r; } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); } }
    };
  } else {
    if (process.env.VERCEL) throw new Error('DATABASE_URL is not set. In Vercel: Storage → create a Neon Postgres database and connect it to this project.');
    let PGlite; try { ({ PGlite } = require(['@electric-sql', 'pglite'].join('/'))); } catch { throw new Error('No DATABASE_URL set and the local database engine is missing. Run "npm install".'); }
    const pg = new PGlite(process.env.PGLITE_DIR === 'memory' ? undefined : (process.env.PGLITE_DIR || require('path').join(process.env.DATA_DIR || require('path').join(__dirname, 'data'), 'pgdata')));
    await pg.waitReady;
    raw = { run: (t, v) => pg.query(t, v), exec: s => pg.exec(s), tx: fn => pg.transaction(t => fn({ run: (c, v) => t.query(c, v), exec: s => t.exec(s) })) };
  }
  const base = api(raw);
  base.tx = fn => raw.tx(t => fn(api(t)));
  return base;
}
module.exports = { createDb };
