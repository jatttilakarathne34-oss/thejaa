'use strict';
const express = require('express'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), cookieParser = require('cookie-parser'), ExcelJS = require('exceljs');
const { invoicePDF, reportPDF } = require('./pdf');
const { createDb } = require('./db');

let D, SECRET;
const SCHEMA_VERSION = '1';
const logErr = (e, ctx = '') => { console.error(`[${ctx}]`, (e && e.stack) || e); if (D) D.run('INSERT INTO error_logs(context,message) VALUES(@c,@m)', { c: String(ctx).slice(0, 200), m: String((e && e.stack) || e).slice(0, 2000) }).catch(() => {}); };
process.on('unhandledRejection', e => logErr(e, 'unhandled'));

// ───────── schema ─────────
const DDL = `
CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('owner','manager','employee')), permissions TEXT, active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users(lower(username));
CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, price DOUBLE PRECISION NOT NULL CHECK(price>=0), cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_pct DOUBLE PRECISION NOT NULL DEFAULT 0, discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0, stock DOUBLE PRECISION NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS customers(id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY, invoice_no TEXT UNIQUE NOT NULL, client_ref TEXT UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), customer_name TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id), subtotal DOUBLE PRECISION NOT NULL, discount_total DOUBLE PRECISION NOT NULL, tax_total DOUBLE PRECISION NOT NULL, total DOUBLE PRECISION NOT NULL,
  paid DOUBLE PRECISION NOT NULL, prev_outstanding DOUBLE PRECISION NOT NULL DEFAULT 0, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), cancelled_at TIMESTAMPTZ, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT);
CREATE TABLE IF NOT EXISTS order_items(id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), sku TEXT, name TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL, unit_price DOUBLE PRECISION NOT NULL, cost DOUBLE PRECISION NOT NULL DEFAULT 0, discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0, discount_amt DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_pct DOUBLE PRECISION NOT NULL DEFAULT 0, tax_amt DOUBLE PRECISION NOT NULL DEFAULT 0, line_total DOUBLE PRECISION NOT NULL, is_return INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS order_pdfs(order_id INTEGER PRIMARY KEY REFERENCES orders(id), invoice_no TEXT NOT NULL, pdf BYTEA NOT NULL, size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payments(id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), amount DOUBLE PRECISION NOT NULL CHECK(amount>0), method TEXT NOT NULL, note TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS stock_movements(id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), delta DOUBLE PRECISION NOT NULL, reason TEXT, user_id INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS activity_logs(id SERIAL PRIMARY KEY, user_id INTEGER, username TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events(id SERIAL PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, owner_id INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS error_logs(id SERIAL PRIMARY KEY, context TEXT, message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(created_at); CREATE INDEX IF NOT EXISTS ix_orders_user ON orders(user_id); CREATE INDEX IF NOT EXISTS ix_orders_cust ON orders(customer_id);
CREATE INDEX IF NOT EXISTS ix_items_order ON order_items(order_id); CREATE INDEX IF NOT EXISTS ix_pay_cust ON payments(customer_id); CREATE INDEX IF NOT EXISTS ix_logs_created ON activity_logs(created_at);`;
const DEFAULT_SET = { business_name: 'My Business', business_address: '', business_phone: '', receipt_footer: 'Thank you!', route_name: '', tz_offset: '330', low_stock: '10', logo: '', invoice_seq: '0' };
let readyP = null;
const ready = () => readyP || (readyP = (async () => {
  if (!process.env.DATABASE_URL && !process.env.VERCEL) fs.mkdirSync(process.env.DATA_DIR || path.join(__dirname, 'data'), { recursive: true });
  D = await createDb();
  const e = await D.get("SELECT to_regclass('public.settings') AS r"); let ok = false;
  if (e && e.r) { const v = await D.get("SELECT value FROM settings WHERE key='schema_version'"); ok = !!v && v.value === SCHEMA_VERSION; }
  if (!ok) await D.tx(async t => {
    await t.get('SELECT pg_advisory_xact_lock(727274)'); await t.exec(DDL);
    for (const [k, v] of Object.entries(DEFAULT_SET)) await t.run('INSERT INTO settings(key,value) VALUES(@k,@v) ON CONFLICT(key) DO NOTHING', { k, v });
    await t.run("INSERT INTO settings(key,value) VALUES('schema_version',@v) ON CONFLICT(key) DO UPDATE SET value=excluded.value", { v: SCHEMA_VERSION });
  });
  SECRET = process.env.JWT_SECRET || (await getS('jwt_secret')) || await (async () => { const s = crypto.randomBytes(48).toString('hex'); await setS('jwt_secret', s); return (await getS('jwt_secret')); })();
})().catch(e => { readyP = null; throw e; }));

// ───────── settings (short per-instance cache) ─────────
let _cfg = null, _cfgT = 0;
async function cfg() { if (_cfg && Date.now() - _cfgT < 5000) return _cfg; const o = Object.fromEntries((await D.all('SELECT key,value FROM settings')).map(r => [r.key, r.value])); _cfg = o; _cfgT = Date.now(); return o; }
const getS = async k => (await D.get('SELECT value FROM settings WHERE key=@k', { k }))?.value ?? null;
const setS = async (k, v) => { await D.run('INSERT INTO settings(key,value) VALUES(@k,@v) ON CONFLICT(key) DO UPDATE SET value=excluded.value', { k, v: String(v) }); _cfg = null; };
const pubSettings = async () => { const o = { ...(await cfg()) }; delete o.jwt_secret; delete o.invoice_seq; delete o.schema_version; return o; };
const offMin = async () => parseInt((await cfg()).tz_offset ?? '330') || 0;
const today = async () => new Date(Date.now() + (await offMin()) * 60000).toISOString().slice(0, 10);

// ───────── helpers ─────────
class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m, s = 400) => { throw new HttpErr(s, m); };
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v, min = -Infinity, max = Infinity, label = 'Value') => { const n = Number(v); if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max) bad(`${label} is invalid`); return n; };
const wrap = fn => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const L = "((o.created_at AT TIME ZONE 'UTC') + (@off::int * interval '1 minute'))::date";
const A = async (req, action, entity, id, detail) => { try { await D.run('INSERT INTO activity_logs(user_id,username,action,entity,entity_id,detail,ip) VALUES(@u,@un,@a,@e,@i,@d,@ip)', { u: req.user?.id ?? null, un: req.user?.username ?? null, a: action, e: entity ?? null, i: id == null ? null : String(id), d: detail ? String(detail).slice(0, 500) : null, ip: req.ip }); } catch (e) { logErr(e, 'activity'); } };
const toBuf = doc => new Promise((ok, no) => { const c = []; doc.on('data', x => c.push(x)); doc.on('end', () => ok(Buffer.concat(c))); doc.on('error', no); });

// ───────── roles & permissions ─────────
const ALL = ['pos.sell', 'pos.discount', 'orders.view_all', 'orders.view_own', 'orders.cancel', 'products.view', 'products.manage', 'inventory.manage', 'customers.manage', 'creditors.manage', 'reports.view', 'reports.export', 'users.manage', 'logs.view'];
const DEF = {
  owner: ALL,
  manager: ['pos.sell', 'pos.discount', 'orders.view_all', 'orders.view_own', 'products.view', 'inventory.manage', 'customers.manage', 'creditors.manage', 'reports.view', 'reports.export', 'users.manage', 'logs.view'],
  employee: ['pos.sell', 'orders.view_own']
};
function effectivePerms(u) {
  if (u.role === 'owner') return ALL;
  let p = DEF[u.role];
  if (u.permissions) { try { const x = JSON.parse(u.permissions); if (Array.isArray(x)) p = x.filter(k => ALL.includes(k)); } catch {} }
  if (u.role !== 'manager') p = p.filter(k => k !== 'users.manage');
  return p;
}
const pubUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, created_at: u.created_at, last_login: u.last_login, permissions: effectivePerms(u) });

// ───────── app ─────────
const app = express(); app.set('trust proxy', true); app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '2mb' })); app.use(cookieParser());
app.use('/api', (req, res, next) => { ready().then(() => next(), next); });
app.use('/api', (req, res, next) => { if (req.method !== 'GET' && req.get('X-CSRF') !== '1') return res.status(403).json({ error: 'Blocked (CSRF)' }); next(); });

async function auth(req, res, next) {
  try {
    const t = req.cookies.token; if (!t) return res.status(401).json({ error: 'Please sign in' });
    let p; try { p = jwt.verify(t, SECRET); } catch { return res.status(401).json({ error: 'Session expired' }); }
    const u = await D.get('SELECT * FROM users WHERE id=@id', { id: p.id });
    if (!u || !u.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = u; req.perms = effectivePerms(u); next();
  } catch (e) { next(e); }
}
const need = (...ps) => (req, res, next) => ps.some(p => req.perms.includes(p)) ? next() : res.status(403).json({ error: 'You do not have permission for this action' });
const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' });

// ───────── live events (polling; works on serverless) ─────────
async function emit(type, data, ownerId) {
  try { await D.run('INSERT INTO events(type,payload,owner_id) VALUES(@t,@p,@o)', { t: type, p: JSON.stringify(data), o: ownerId ?? null });
    if (Math.random() < 0.02) await D.run("DELETE FROM events WHERE created_at<now()-interval '1 day'"); } catch (e) { logErr(e, 'emit'); }
}
app.get('/api/poll', auth, wrap(async (req, res) => {
  const last = (await D.get('SELECT COALESCE(MAX(id),0)::int m FROM events')).m, since = parseInt(req.query.since);
  if (!Number.isFinite(since)) return res.json({ last, events: [] });
  const rows = await D.all('SELECT * FROM events WHERE id>@s ORDER BY id LIMIT 100', { s: since }), all = req.perms.includes('orders.view_all');
  res.json({ last: rows.length ? rows[rows.length - 1].id : since, events: rows.filter(e => e.type !== 'order' || all || e.owner_id === req.user.id).map(e => ({ id: e.id, type: e.type, data: JSON.parse(e.payload) })) });
}));

// ───────── auth routes ─────────
app.get('/api/status', wrap(async (req, res) => { const s = await cfg(); res.json({ needsSetup: (await D.get('SELECT COUNT(*)::int n FROM users')).n === 0, business: s.business_name, logo: s.logo }); }));
app.post('/api/setup', wrap(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 80), username = str(b.username, 32), pw = String(b.password || '');
  if (!name || !/^[a-z0-9._-]{3,32}$/i.test(username)) bad('Enter a name and a username (3-32 letters/numbers)');
  if (pw.length < 8) bad('Password must be at least 8 characters');
  const hash = await bcrypt.hash(pw, 10), id = await D.tx(async t => {
    await t.get('SELECT pg_advisory_xact_lock(727275)');
    if ((await t.get('SELECT COUNT(*)::int n FROM users')).n) bad('Setup already completed', 403);
    return (await t.get('INSERT INTO users(username,name,password_hash,role) VALUES(@u,@n,@h,@r) RETURNING id', { u: username, n: name, h: hash, r: 'owner' })).id;
  });
  if (b.business) await setS('business_name', str(b.business, 100));
  req.user = { id, username }; await A(req, 'setup', 'user', id, 'Owner account created'); res.json({ ok: true });
}));
app.post('/api/login', wrap(async (req, res) => {
  const b = req.body || {}, username = str(b.username, 40);
  const fails = (await D.get("SELECT COUNT(*)::int n FROM activity_logs WHERE action='login.failed' AND detail=@d AND created_at>now()-interval '15 minutes'", { d: username.toLowerCase() })).n;
  if (fails >= 8) bad('Too many failed attempts. Try again in 15 minutes.', 429);
  const u = await D.get('SELECT * FROM users WHERE lower(username)=lower(@u)', { u: username });
  if (!u || !u.active || !(await bcrypt.compare(String(b.password || ''), u.password_hash))) { req.user = u || { username }; await A(req, 'login.failed', 'user', u?.id, username.toLowerCase()); bad('Invalid username or password', 401); }
  await D.run('UPDATE users SET last_login=now() WHERE id=@id', { id: u.id }); req.user = u; await A(req, 'login', 'user', u.id);
  res.cookie('token', jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 12 * 3600e3 });
  res.json({ ok: true });
}));
app.post('/api/logout', auth, wrap(async (req, res) => { await A(req, 'logout', 'user', req.user.id); res.clearCookie('token'); res.json({ ok: true }); }));
app.get('/api/me', auth, wrap(async (req, res) => res.json({ user: pubUser(req.user), perms: req.perms, settings: await pubSettings() })));
app.patch('/api/me/password', auth, wrap(async (req, res) => {
  const b = req.body || {}; if (!(await bcrypt.compare(String(b.current || ''), req.user.password_hash))) bad('Current password is wrong');
  if (String(b.password || '').length < 8) bad('New password must be at least 8 characters');
  await D.run('UPDATE users SET password_hash=@h WHERE id=@id', { h: await bcrypt.hash(b.password, 10), id: req.user.id }); await A(req, 'password.change', 'user', req.user.id); res.json({ ok: true });
}));
app.get('/api/me/stats', auth, wrap(async (req, res) => res.json(await D.get(`SELECT COALESCE(SUM(total),0) revenue, COUNT(*)::int orders FROM orders o WHERE user_id=@u AND status='completed' AND ${L}=@t`, { u: req.user.id, off: await offMin(), t: await today() }))));

// ───────── users ─────────
function cleanPerms(req, role, list) {
  if (!Array.isArray(list)) return null;
  let p = list.filter(k => ALL.includes(k)); if (req.user.role !== 'owner') p = p.filter(k => req.perms.includes(k)); if (role !== 'manager') p = p.filter(k => k !== 'users.manage');
  return JSON.stringify([...new Set(p)]);
}
app.get('/api/users', auth, need('users.manage'), wrap(async (req, res) => {
  const rows = req.user.role === 'owner' ? await D.all('SELECT * FROM users ORDER BY id') : await D.all("SELECT * FROM users WHERE role='employee' ORDER BY id");
  res.json({ users: rows.map(pubUser), defaults: DEF, all: ALL });
}));
app.post('/api/users', auth, need('users.manage'), wrap(async (req, res) => {
  const b = req.body || {}, role = b.role, name = str(b.name, 80), username = str(b.username, 32);
  if (!['manager', 'employee'].includes(role)) bad('Choose a role'); if (req.user.role !== 'owner' && role !== 'employee') bad('Managers can only create employees', 403);
  if (!name || !/^[a-z0-9._-]{3,32}$/i.test(username)) bad('Name and username (3-32 letters/numbers/._-) are required');
  if (String(b.password || '').length < 8) bad('Password must be at least 8 characters');
  if (await D.get('SELECT 1 x FROM users WHERE lower(username)=lower(@u)', { u: username })) bad('Username already taken', 409);
  const u = await D.get('INSERT INTO users(username,name,password_hash,role,permissions,created_by) VALUES(@u,@n,@h,@r,@p,@c) RETURNING *', { u: username, n: name, h: await bcrypt.hash(b.password, 10), r: role, p: cleanPerms(req, role, b.permissions), c: req.user.id });
  await A(req, 'user.create', 'user', u.id, `${username} (${role})`); res.json(pubUser(u));
}));
app.patch('/api/users/:id', auth, need('users.manage'), wrap(async (req, res) => {
  const t = await D.get('SELECT * FROM users WHERE id=@id', { id: +req.params.id }); if (!t) bad('User not found', 404);
  if (t.role === 'owner') bad('The owner account cannot be modified here', 403);
  if (req.user.role !== 'owner' && t.role !== 'employee') bad('Managers can only manage employees', 403);
  const b = req.body || {}; let role = t.role;
  if (b.role !== undefined && b.role !== t.role) { if (req.user.role !== 'owner') bad('Only the owner can change roles', 403); if (!['manager', 'employee'].includes(b.role)) bad('Invalid role'); role = b.role; }
  const name = b.name !== undefined ? str(b.name, 80) : t.name; if (!name) bad('Name required');
  let active = t.active; if (b.active !== undefined) { if (t.id === req.user.id) bad('You cannot deactivate yourself'); active = b.active ? 1 : 0; }
  const perms = b.permissions !== undefined ? cleanPerms(req, role, b.permissions) : (role !== t.role ? null : t.permissions);
  let hash = t.password_hash; if (b.password) { if (String(b.password).length < 8) bad('Password must be at least 8 characters'); hash = await bcrypt.hash(b.password, 10); }
  const u = await D.get('UPDATE users SET name=@n,role=@r,active=@a,permissions=@p,password_hash=@h WHERE id=@id RETURNING *', { n: name, r: role, a: active, p: perms, h: hash, id: t.id });
  await A(req, active !== t.active ? (active ? 'user.activate' : 'user.deactivate') : 'user.update', 'user', t.id, `${t.username}${b.password ? ' (password reset)' : ''}${role !== t.role ? ` role ${t.role}→${role}` : ''}`);
  res.json(pubUser(u));
}));

// ───────── products & stock ─────────
app.get('/api/products', auth, need('pos.sell', 'products.view'), wrap(async (req, res) => {
  const full = req.perms.includes('products.view'), cost = req.perms.includes('products.manage') || req.perms.includes('reports.view');
  res.json(await D.all(`SELECT id,sku,name,price,${cost ? 'cost,' : ''}tax_pct,discount_pct,stock,active FROM products ${full && req.query.all === '1' ? '' : 'WHERE active=1'} ORDER BY name`));
}));
function prodBody(b, cur) {
  const name = str(b.name ?? cur?.name, 120).toUpperCase(); if (!name) bad('Product name is required');
  return { name, price: num(b.price ?? cur?.price, 0, 1e9, 'Price'), cost: num(b.cost ?? cur?.cost ?? 0, 0, 1e9, 'Cost'), tax_pct: num(b.tax_pct ?? cur?.tax_pct ?? 0, 0, 100, 'Tax'), discount_pct: num(b.discount_pct ?? cur?.discount_pct ?? 0, 0, 100, 'Discount') };
}
app.post('/api/products', auth, need('products.manage'), wrap(async (req, res) => {
  const b = req.body || {}, p = prodBody(b), sku = str(b.sku, 40).toUpperCase() || 'SKU-' + Date.now().toString(36).toUpperCase();
  if (await D.get('SELECT 1 x FROM products WHERE sku=@s', { s: sku })) bad('SKU already exists', 409);
  const stock = num(b.stock ?? 0, 0, 1e9, 'Stock');
  const id = await D.tx(async t => { const id = (await t.get('INSERT INTO products(sku,name,price,cost,tax_pct,discount_pct,stock) VALUES(@sku,@n,@p,@c,@t,@d,@s) RETURNING id', { sku, n: p.name, p: p.price, c: p.cost, t: p.tax_pct, d: p.discount_pct, s: stock })).id;
    if (stock) await t.run('INSERT INTO stock_movements(product_id,delta,reason,user_id) VALUES(@p,@d,@r,@u)', { p: id, d: stock, r: 'Opening stock', u: req.user.id }); return id; });
  await A(req, 'product.create', 'product', id, `${p.name} @ ${p.price}`); await emit('product', { id }); res.json({ id });
}));
app.patch('/api/products/:id', auth, need('products.manage'), wrap(async (req, res) => {
  const cur = await D.get('SELECT * FROM products WHERE id=@id', { id: +req.params.id }); if (!cur) bad('Product not found', 404);
  const b = req.body || {}, p = prodBody(b, cur), active = b.active === undefined ? cur.active : (b.active ? 1 : 0);
  await D.run('UPDATE products SET name=@n,price=@p,cost=@c,tax_pct=@t,discount_pct=@d,active=@a,updated_at=now() WHERE id=@id', { n: p.name, p: p.price, c: p.cost, t: p.tax_pct, d: p.discount_pct, a: active, id: cur.id });
  if (p.price !== cur.price) await A(req, 'product.price', 'product', cur.id, `${cur.name}: ${cur.price} → ${p.price}`);
  if (p.discount_pct !== cur.discount_pct) await A(req, 'product.discount', 'product', cur.id, `${cur.name}: ${cur.discount_pct}% → ${p.discount_pct}%`);
  if (active !== cur.active) await A(req, active ? 'product.restore' : 'product.archive', 'product', cur.id, cur.name);
  if (p.name !== cur.name || p.cost !== cur.cost || p.tax_pct !== cur.tax_pct) await A(req, 'product.update', 'product', cur.id, p.name);
  await emit('product', { id: cur.id }); res.json({ ok: true });
}));
app.delete('/api/products/:id', auth, need('products.manage'), wrap(async (req, res) => {
  const cur = await D.get('SELECT * FROM products WHERE id=@id', { id: +req.params.id }); if (!cur) bad('Product not found', 404);
  await D.run('UPDATE products SET active=0 WHERE id=@id', { id: cur.id }); await A(req, 'product.archive', 'product', cur.id, cur.name); await emit('product', { id: cur.id }); res.json({ ok: true });
}));
app.post('/api/products/:id/stock', auth, need('inventory.manage'), wrap(async (req, res) => {
  const cur = await D.get('SELECT * FROM products WHERE id=@id', { id: +req.params.id }); if (!cur) bad('Product not found', 404);
  const delta = num(req.body?.delta, -1e9, 1e9, 'Quantity'); if (!delta) bad('Quantity cannot be zero');
  await D.tx(async t => {
    const r = await t.run('UPDATE products SET stock=stock+@d,updated_at=now() WHERE id=@id AND stock+@d>=-0.000001', { d: delta, id: cur.id }); if (!r.count) bad('Stock cannot go below zero');
    await t.run('INSERT INTO stock_movements(product_id,delta,reason,user_id) VALUES(@p,@d,@r,@u)', { p: cur.id, d: delta, r: str(req.body?.reason, 120) || 'Stock adjustment', u: req.user.id });
  });
  await A(req, 'stock.adjust', 'product', cur.id, `${cur.name}: ${delta > 0 ? '+' : ''}${delta}`); await emit('product', { id: cur.id }); res.json({ stock: r2(cur.stock + delta) });
}));
app.get('/api/stock/movements', auth, need('inventory.manage'), wrap(async (req, res) => res.json(await D.all('SELECT m.*,p.name product,u.name "user" FROM stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 100'))));

// ───────── customers, creditors, payments ─────────
const BAL = `(COALESCE((SELECT SUM(total-paid) FROM orders WHERE customer_id=c.id AND status='completed'),0)-COALESCE((SELECT SUM(amount) FROM payments WHERE customer_id=c.id),0))`;
const custBalance = async (id, t = D) => r2((await t.get(`SELECT ${BAL} AS b FROM customers c WHERE c.id=@id`, { id }))?.b || 0);
app.get('/api/customers', auth, need('pos.sell', 'customers.manage', 'creditors.manage'), wrap(async (req, res) => {
  res.json(await D.all(`SELECT c.id,c.name,c.phone,c.address,c.created_at,ROUND((${BAL})::numeric,2)::float8 AS balance FROM customers c WHERE c.name ILIKE @q OR COALESCE(c.phone,'') ILIKE @q ORDER BY c.name LIMIT 500`, { q: `%${str(req.query.q, 60)}%` }));
}));
app.post('/api/customers', auth, need('pos.sell', 'customers.manage'), wrap(async (req, res) => {
  const name = str(req.body?.name, 100); if (!name) bad('Customer name is required');
  const id = (await D.get('INSERT INTO customers(name,phone,address) VALUES(@n,@p,@a) RETURNING id', { n: name, p: str(req.body?.phone, 30), a: str(req.body?.address, 200) })).id; await A(req, 'customer.create', 'customer', id, name); res.json({ id, name });
}));
app.patch('/api/customers/:id', auth, need('customers.manage'), wrap(async (req, res) => {
  const c = await D.get('SELECT * FROM customers WHERE id=@id', { id: +req.params.id }); if (!c) bad('Customer not found', 404);
  const name = str(req.body?.name ?? c.name, 100); if (!name) bad('Name required');
  await D.run('UPDATE customers SET name=@n,phone=@p,address=@a WHERE id=@id', { n: name, p: str(req.body?.phone ?? c.phone, 30), a: str(req.body?.address ?? c.address, 200), id: c.id }); await A(req, 'customer.update', 'customer', c.id, name); res.json({ ok: true });
}));
app.get('/api/customers/:id/ledger', auth, need('customers.manage', 'creditors.manage'), wrap(async (req, res) => {
  const c = await D.get('SELECT * FROM customers WHERE id=@id', { id: +req.params.id }); if (!c) bad('Customer not found', 404);
  res.json({ customer: c, balance: await custBalance(c.id), orders: await D.all('SELECT id,invoice_no,created_at,total,paid,status,payment_method FROM orders WHERE customer_id=@id ORDER BY id DESC LIMIT 100', { id: c.id }),
    payments: await D.all('SELECT p.*,u.name "user" FROM payments p JOIN users u ON u.id=p.user_id WHERE customer_id=@id ORDER BY p.id DESC LIMIT 100', { id: c.id }) });
}));
app.get('/api/creditors', auth, need('creditors.manage', 'reports.view'), wrap(async (req, res) => res.json(await D.all(`SELECT * FROM (SELECT c.id,c.name,c.phone,ROUND((${BAL})::numeric,2)::float8 AS balance,(SELECT MAX(created_at) FROM orders WHERE customer_id=c.id) AS last_order FROM customers c) x WHERE balance>0.005 ORDER BY balance DESC`))));
app.post('/api/payments', auth, need('creditors.manage'), wrap(async (req, res) => {
  const c = await D.get('SELECT * FROM customers WHERE id=@id', { id: +req.body?.customer_id }); if (!c) bad('Customer not found', 404);
  const amt = r2(num(req.body?.amount, 0.01, 1e9, 'Amount')), method = ['cash', 'card', 'transfer'].includes(req.body?.method) ? req.body.method : 'cash';
  const bal = await D.tx(async t => { await t.get('SELECT id FROM customers WHERE id=@id FOR UPDATE', { id: c.id }); const b = await custBalance(c.id, t); if (amt > b + 0.005) bad(`Amount exceeds outstanding balance (${b.toFixed(2)})`);
    await t.run('INSERT INTO payments(customer_id,amount,method,note,user_id) VALUES(@c,@a,@m,@n,@u)', { c: c.id, a: amt, m: method, n: str(req.body?.note, 200), u: req.user.id }); return custBalance(c.id, t); });
  await A(req, 'payment.create', 'customer', c.id, `${c.name}: ${amt} (${method})`); await emit('payment', { customer_id: c.id }); res.json({ balance: bal });
}));

// ───────── orders & PDFs (A4 invoice is stored in the database) ─────────
async function orderFull(id) {
  const o = await D.get('SELECT o.*,u.name employee,c.phone customer_phone,c.address customer_address FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=@id', { id });
  if (o) o.items = await D.all('SELECT * FROM order_items WHERE order_id=@id ORDER BY id', { id }); return o;
}
const canSee = (req, o) => req.perms.includes('orders.view_all') || (req.perms.includes('orders.view_own') && o.user_id === req.user.id);
async function savePdf(id, replace) {
  const o = await orderFull(id), buf = await toBuf(invoicePDF(o, await pubSettings(), 'a4'));
  await D.run(`INSERT INTO order_pdfs(order_id,invoice_no,pdf,size) VALUES(@i,@n,@p,@s) ON CONFLICT(order_id) DO ${replace ? 'UPDATE SET pdf=excluded.pdf,size=excluded.size,updated_at=now()' : 'NOTHING'}`, { i: id, n: o.invoice_no, p: buf, s: buf.length });
}
async function getPdf(id) { let r = await D.get('SELECT pdf FROM order_pdfs WHERE order_id=@id', { id }); if (!r) { await savePdf(id, false); r = await D.get('SELECT pdf FROM order_pdfs WHERE order_id=@id', { id }); } return Buffer.from(r.pdf); }

app.post('/api/orders', auth, need('pos.sell'), wrap(async (req, res) => {
  const b = req.body || {}, ref = str(b.client_ref, 80); if (!/^[\w-]{8,80}$/.test(ref)) bad('Missing order reference');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 200) bad('Add at least one item');
  const method = ['cash', 'card', 'transfer', 'credit'].includes(b.payment_method) ? b.payment_method : bad('Choose a payment method');
  const canDisc = req.perms.includes('pos.discount');
  let out;
  try {
    out = await D.tx(async t => {
      const ex = await t.get('SELECT id,invoice_no,total FROM orders WHERE client_ref=@r', { r: ref }); if (ex) return { ...ex, duplicate: true };
      let cust = null; if (b.customer_id) { cust = await t.get('SELECT * FROM customers WHERE id=@id', { id: +b.customer_id }); if (!cust) bad('Customer not found'); }
      if (method === 'credit' && !cust) bad('Select a customer for credit sales');
      const ids = [...new Set(b.items.map(i => +i.product_id))]; if (ids.some(i => !Number.isInteger(i))) bad('Invalid product');
      const prods = new Map((await t.all('SELECT * FROM products WHERE id=ANY(@ids) AND active=1', { ids })).map(p => [p.id, p]));
      const lines = []; let sub = 0, disc = 0, tax = 0, total = 0;
      for (const it of b.items) {
        const p = prods.get(+it.product_id); if (!p) bad('A product is no longer available');
        const qty = num(it.qty, 0.001, 100000, 'Quantity'), ret = it.is_return ? 1 : 0, sg = ret ? -1 : 1;
        let dp = p.discount_pct; if (canDisc && it.discount_pct !== undefined && it.discount_pct !== null && it.discount_pct !== '') dp = num(it.discount_pct, 0, 100, 'Discount');
        const gross = r2(p.price * qty), da = r2(gross * dp / 100), ta = r2((gross - da) * p.tax_pct / 100), lt = r2(gross - da + ta);
        const up = ret ? await t.run('UPDATE products SET stock=stock+@q,updated_at=now() WHERE id=@id', { q: qty, id: p.id }) : await t.run('UPDATE products SET stock=stock-@q,updated_at=now() WHERE id=@id AND stock>=@q-0.0000001', { q: qty, id: p.id });
        if (!up.count) bad(`Not enough stock for ${p.name} (available ${(await t.get('SELECT stock FROM products WHERE id=@id', { id: p.id })).stock})`, 409);
        sub += sg * gross; disc += sg * da; tax += sg * ta; total += sg * lt; lines.push({ p, qty, ret, dp, da, ta, lt: sg * lt });
      }
      sub = r2(sub); disc = r2(disc); tax = r2(tax); total = r2(total); if (total < 0) bad('Returns exceed the sale total');
      const paid = method === 'credit' ? r2(num(b.paid ?? 0, 0, total, 'Paid amount')) : total;
      const prev = cust ? Math.max(0, await custBalance(cust.id, t)) : 0;
      const seq = parseInt((await t.get("UPDATE settings SET value=((value::int)+1)::text WHERE key='invoice_seq' RETURNING value")).value), inv = 'INV-' + String(seq).padStart(6, '0');
      const id = (await t.get('INSERT INTO orders(invoice_no,client_ref,customer_id,customer_name,user_id,subtotal,discount_total,tax_total,total,paid,prev_outstanding,payment_method,note) VALUES(@inv,@ref,@cid,@cn,@u,@s,@d,@t,@tt,@p,@pv,@m,@n) RETURNING id',
        { inv, ref, cid: cust?.id ?? null, cn: cust?.name ?? (str(b.customer_name, 100) || 'Walk-in Customer'), u: req.user.id, s: sub, d: disc, t: tax, tt: total, p: paid, pv: prev, m: method, n: str(b.note, 200) })).id;
      const vals = [], ph = lines.map(l => { vals.push(id, l.p.id, l.p.sku, l.p.name, l.qty, l.p.price, l.p.cost, l.dp, l.da, l.p.tax_pct, l.ta, l.lt, l.ret); return '(' + Array(13).fill('?').join(',') + ')'; });
      await t.run(`INSERT INTO order_items(order_id,product_id,sku,name,qty,unit_price,cost,discount_pct,discount_amt,tax_pct,tax_amt,line_total,is_return) VALUES ${ph.join(',')}`, vals);
      return { id, invoice_no: inv, total, disc };
    });
  } catch (e) { if (e.code === '23505' && /client_ref/.test(`${e.constraint} ${e.detail} ${e.message}`)) { const ex = await D.get('SELECT id,invoice_no,total FROM orders WHERE client_ref=@r', { r: ref }); if (ex) return res.json({ ...ex, duplicate: true }); } throw e; }
  if (out.duplicate) return res.json(out);
  await A(req, 'order.create', 'order', out.id, `${out.invoice_no} Rs.${out.total} ${method}`); if (out.disc > 0) await A(req, 'discount.applied', 'order', out.id, `${out.invoice_no}: Rs.${out.disc}`);
  try { await savePdf(out.id, false); } catch (e) { logErr(e, 'pdf'); } // order is already saved; PDF is regenerated on demand if this failed
  await emit('order', { id: out.id, invoice_no: out.invoice_no, total: out.total, employee: req.user.name, event: 'created' }, req.user.id); await emit('product', {});
  res.json({ id: out.id, invoice_no: out.invoice_no, total: out.total });
}));
app.get('/api/orders', auth, need('orders.view_all', 'orders.view_own'), wrap(async (req, res) => {
  const w = ['1=1'], p = { off: await offMin() }, all = req.perms.includes('orders.view_all');
  if (!all) { w.push('o.user_id=@me'); p.me = req.user.id; } else if (+req.query.user) { w.push('o.user_id=@u'); p.u = +req.query.user; }
  if (isDate(req.query.from)) { w.push(`${L}>=@from`); p.from = req.query.from; } if (isDate(req.query.to)) { w.push(`${L}<=@to`); p.to = req.query.to; }
  if (['completed', 'cancelled'].includes(req.query.status)) { w.push('o.status=@st'); p.st = req.query.status; }
  if (req.query.q) { w.push('(o.invoice_no ILIKE @q OR o.customer_name ILIKE @q)'); p.q = `%${str(req.query.q, 40)}%`; }
  res.json(await D.all(`SELECT o.id,o.invoice_no,o.created_at,o.customer_name,o.total,o.paid,o.discount_total,o.payment_method,o.status,u.name employee FROM orders o JOIN users u ON u.id=o.user_id WHERE ${w.join(' AND ')} ORDER BY o.id DESC LIMIT ${Math.min(+req.query.limit || 200, 500)}`, p));
}));
app.get('/api/orders/:id', auth, need('orders.view_all', 'orders.view_own'), wrap(async (req, res) => { const o = await orderFull(+req.params.id); if (!o || !canSee(req, o)) bad('Order not found', 404); res.json(o); }));
app.get('/api/orders/:id/pdf', auth, need('orders.view_all', 'orders.view_own'), wrap(async (req, res) => {
  const o = await orderFull(+req.params.id); if (!o || !canSee(req, o)) bad('Order not found', 404);
  const thermal = req.query.format === 'thermal', buf = thermal ? await toBuf(invoicePDF(o, await pubSettings(), 'thermal')) : await getPdf(o.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${o.invoice_no}${thermal ? '-57mm' : ''}.pdf"` }); res.end(buf);
}));
app.post('/api/orders/:id/cancel', auth, need('orders.cancel'), wrap(async (req, res) => {
  const reason = str(req.body?.reason, 200); if (!reason) bad('A cancellation reason is required');
  const o = await D.get('SELECT * FROM orders WHERE id=@id', { id: +req.params.id }); if (!o) bad('Order not found', 404);
  await D.tx(async t => {
    const r = await t.run("UPDATE orders SET status='cancelled',cancelled_at=now(),cancelled_by=@u,cancel_reason=@r WHERE id=@id AND status='completed'", { u: req.user.id, r: reason, id: o.id }); if (!r.count) bad('Order already cancelled', 409);
    for (const i of await t.all('SELECT * FROM order_items WHERE order_id=@id', { id: o.id })) await t.run('UPDATE products SET stock=stock+@d WHERE id=@p', { d: i.is_return ? -i.qty : i.qty, p: i.product_id });
  });
  try { await savePdf(o.id, true); } catch (e) { logErr(e, 'pdf'); } // stored PDF is re-issued with a CANCELLED stamp
  await A(req, 'order.cancel', 'order', o.id, `${o.invoice_no}: ${reason}`); await emit('order', { id: o.id, invoice_no: o.invoice_no, event: 'cancelled' }, o.user_id); await emit('product', {}); res.json({ ok: true });
}));

// ───────── analytics ─────────
async function summary(from, to) {
  const off = await offMin(), t = await today(), P = (a, b) => D.get(`SELECT COALESCE(SUM(total),0) revenue,COUNT(*)::int orders,COALESCE(SUM(discount_total),0) discounts FROM orders o WHERE status='completed' AND ${L} BETWEEN @a AND @b`, { off, a, b });
  const cards = { today: await P(t, t), yesterday: await P(addDays(t, -1), addDays(t, -1)), week: await P(addDays(t, -6), t), month: await P(t.slice(0, 8) + '01', t), year: await P(t.slice(0, 5) + '01-01', t) };
  const base = { off, a: from, b: to };
  const range_stats = await D.get(`SELECT COALESCE(SUM(total),0) revenue,COUNT(*)::int orders,COALESCE(SUM(discount_total),0) discounts,COALESCE(SUM(tax_total),0) tax,COALESCE(SUM(CASE WHEN paid>=total-0.005 THEN 1 ELSE 0 END),0)::int paid_orders,COALESCE(SUM(CASE WHEN paid<total-0.005 THEN 1 ELSE 0 END),0)::int unpaid_orders FROM orders o WHERE status='completed' AND ${L} BETWEEN @a AND @b`, base);
  range_stats.avg_order = range_stats.orders ? r2(range_stats.revenue / range_stats.orders) : 0; range_stats.cancelled = (await D.get(`SELECT COUNT(*)::int n FROM orders o WHERE status='cancelled' AND ${L} BETWEEN @a AND @b`, base)).n;
  const grp = e => D.all(`SELECT ${e} AS label,COALESCE(SUM(total),0) revenue,COUNT(*)::int orders FROM orders o WHERE status='completed' AND ${L} BETWEEN @a AND @b GROUP BY 1 ORDER BY 1`, base);
  const day = await grp(`to_char(${L},'YYYY-MM-DD')`), map = new Map(day.map(r => [r.label, r])), filled = []; for (let d = from, n = 0; d <= to && n < 400; d = addDays(d, 1), n++) filled.push(map.get(d) || { label: d, revenue: 0, orders: 0 });
  const series = { day: filled, week: await grp(`to_char(${L},'IYYY-"W"IW')`), month: await grp(`to_char(${L},'YYYY-MM')`), year: await grp(`to_char(${L},'YYYY')`) };
  const products = await D.all(`SELECT p.id,p.name,COALESCE(a.qty,0) qty,COALESCE(a.revenue,0) revenue,COALESCE(a.discount,0) discount FROM products p LEFT JOIN (SELECT oi.product_id pid,SUM(CASE WHEN oi.is_return=1 THEN -oi.qty ELSE oi.qty END) qty,SUM(oi.line_total) revenue,SUM(CASE WHEN oi.is_return=1 THEN -oi.discount_amt ELSE oi.discount_amt END) discount FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status='completed' AND ${L} BETWEEN @a AND @b GROUP BY oi.product_id) a ON a.pid=p.id WHERE p.active=1 ORDER BY qty DESC,revenue DESC`, base);
  const employees = (await D.all(`SELECT u.id,u.name,u.role,COUNT(o.id)::int orders,COALESCE(SUM(o.total),0) revenue,COALESCE(SUM(o.discount_total),0) discounts FROM users u LEFT JOIN orders o ON o.user_id=u.id AND o.status='completed' AND ${L} BETWEEN @a AND @b GROUP BY u.id ORDER BY revenue DESC`, base)).filter(e => e.role !== 'owner' || e.orders);
  const payments = await D.all(`SELECT payment_method method,COUNT(*)::int orders,COALESCE(SUM(total),0) revenue FROM orders o WHERE status='completed' AND ${L} BETWEEN @a AND @b GROUP BY payment_method ORDER BY revenue DESC`, base);
  const outstanding = r2((await D.get(`SELECT COALESCE(SUM(b),0) v FROM (SELECT ${BAL} AS b FROM customers c) x WHERE b>0.005`)).v);
  return { today: t, range: { from, to }, cards, range_stats, series, products, employees, payments, outstanding };
}
async function rangeOf(q) { const t = await today(); let to = isDate(q.to) ? q.to : t, from = isDate(q.from) ? q.from : addDays(to, -29); if (from > to) [from, to] = [to, from]; if (new Date(to) - new Date(from) > 3660 * 864e5) bad('Range too large'); return [from, to]; }
app.get('/api/reports/summary', auth, need('reports.view'), wrap(async (req, res) => res.json(await summary(...(await rangeOf(req.query))))));
app.get('/api/reports/export', auth, need('reports.export'), wrap(async (req, res) => {
  const [from, to] = await rangeOf(req.query), d = await summary(from, to), S = await pubSettings(); await A(req, 'report.export', 'report', null, `${req.query.type || 'xlsx'} ${from}..${to}`);
  if (req.query.type === 'pdf') { const buf = await toBuf(reportPDF(d, S)); res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="report-${from}_${to}.pdf"` }); return res.end(buf); }
  const wb = new ExcelJS.Workbook(); wb.creator = S.business_name; const hd = ws => { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };
  let ws = wb.addWorksheet('Summary'); ws.columns = [{ header: 'Metric', width: 34 }, { header: 'Value', width: 20 }]; hd(ws); const r = d.range_stats;
  [['From', from], ['To', to], ['Total revenue', r.revenue], ['Orders', r.orders], ['Average order value', r.avg_order], ['Total discounts', r.discounts], ['Tax collected', r.tax], ['Paid orders', r.paid_orders], ['Unpaid/partial orders', r.unpaid_orders], ['Cancelled orders', r.cancelled], ['Outstanding creditor balance', d.outstanding]].forEach(x => ws.addRow(x));
  ws = wb.addWorksheet('Daily'); ws.columns = [{ header: 'Date', width: 14 }, { header: 'Orders', width: 10 }, { header: 'Revenue', width: 16 }]; hd(ws); d.series.day.forEach(s => ws.addRow([s.label, s.orders, s.revenue]));
  ws = wb.addWorksheet('Products'); ws.columns = [{ header: 'Product', width: 34 }, { header: 'Qty sold', width: 12 }, { header: 'Revenue', width: 16 }, { header: 'Discount', width: 14 }]; hd(ws); d.products.forEach(p => ws.addRow([p.name, p.qty, p.revenue, p.discount]));
  ws = wb.addWorksheet('Employees'); ws.columns = [{ header: 'Name', width: 26 }, { header: 'Role', width: 12 }, { header: 'Orders', width: 10 }, { header: 'Revenue', width: 16 }, { header: 'Discounts', width: 14 }]; hd(ws); d.employees.forEach(e => ws.addRow([e.name, e.role, e.orders, e.revenue, e.discounts]));
  ws = wb.addWorksheet('Orders'); ws.columns = ['Invoice', 'Date', 'Employee', 'Customer', 'Method', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Status'].map(h => ({ header: h, width: 16 })); hd(ws);
  (await D.all(`SELECT o.*,u.name employee,to_char((o.created_at AT TIME ZONE 'UTC') + (@off::int * interval '1 minute'),'YYYY-MM-DD HH24:MI:SS') AS local FROM orders o JOIN users u ON u.id=o.user_id WHERE ${L} BETWEEN @a AND @b ORDER BY o.id`, { off: await offMin(), a: from, b: to })).forEach(o => ws.addRow([o.invoice_no, o.local, o.employee, o.customer_name, o.payment_method, o.subtotal, o.discount_total, o.tax_total, o.total, o.paid, o.status]));
  const buf = await wb.xlsx.writeBuffer(); res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="report-${from}_${to}.xlsx"` }); res.end(Buffer.from(buf));
}));

// ───────── logs, settings, export ─────────
app.get('/api/logs', auth, need('logs.view'), wrap(async (req, res) => {
  const own = req.user.role === 'owner';
  res.json(await D.all(`SELECT l.*,u.role FROM activity_logs l LEFT JOIN users u ON u.id=l.user_id WHERE (l.action ILIKE @q OR COALESCE(l.username,'') ILIKE @q OR COALESCE(l.detail,'') ILIKE @q) ${own ? '' : "AND COALESCE(u.role,'')<>'owner'"} ORDER BY l.id DESC LIMIT 300`, { q: `%${str(req.query.q, 40)}%` }));
}));
app.patch('/api/settings', auth, ownerOnly, wrap(async (req, res) => {
  const b = req.body || {}, keys = ['business_name', 'business_address', 'business_phone', 'receipt_footer', 'route_name', 'tz_offset', 'low_stock', 'logo'];
  for (const k of keys) if (b[k] !== undefined) {
    let v = String(b[k]);
    if (k === 'logo') { if (v && (!/^data:image\/(png|jpeg);base64,/.test(v) || v.length > 700000)) bad('Logo must be a PNG/JPEG under 500 KB'); }
    else if (k === 'tz_offset') v = String(num(v, -720, 840, 'Time zone offset')); else if (k === 'low_stock') v = String(num(v, 0, 1e6, 'Low stock')); else v = str(v, 200);
    await setS(k, v);
  }
  await A(req, 'settings.update', 'settings', null, Object.keys(b).filter(k => keys.includes(k)).join(',')); res.json(await pubSettings());
}));
// Full data export (JSON) for your own safety copy. Password hashes and PDFs are excluded (PDFs can be re-issued; the database provider keeps its own point-in-time backups).
app.get('/api/export', auth, ownerOnly, wrap(async (req, res) => {
  const dump = { exported_at: new Date().toISOString(), settings: await pubSettings() };
  for (const [k, s] of Object.entries({ users: 'SELECT id,username,name,role,permissions,active,created_at,last_login FROM users', products: 'SELECT * FROM products', customers: 'SELECT * FROM customers', orders: 'SELECT * FROM orders', order_items: 'SELECT * FROM order_items', payments: 'SELECT * FROM payments', stock_movements: 'SELECT * FROM stock_movements', activity_logs: 'SELECT * FROM activity_logs' })) dump[k] = await D.all(s);
  await A(req, 'data.export', 'database', null, 'JSON export'); res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="billease-export-${new Date().toISOString().slice(0, 10)}.json"` }); res.send(JSON.stringify(dump));
}));

// ───────── static (local only; on Vercel the public/ folder is served by the CDN) & errors ─────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((e, req, res, next) => {
  if (e instanceof HttpErr) return res.status(e.status).json({ error: e.message });
  if (e && e.code === '23505') { logErr(e, req.originalUrl); return res.status(409).json({ error: 'Conflict: duplicate data' }); }
  logErr(e, req.method + ' ' + req.originalUrl); if (!res.headersSent) res.status(500).json({ error: 'Server error. It has been logged.' });
});
const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log(`BillEase running on http://localhost:${PORT}`));
module.exports = app; app._db = () => D;
