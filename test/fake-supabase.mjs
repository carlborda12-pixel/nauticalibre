// "Supabase falso" para pruebas locales: imita Auth (GoTrue) y la API REST (PostgREST)
// sobre un Postgres real con las migraciones del proyecto, y reenvía /functions/v1 a las
// Edge Functions reales corriendo en Deno. NO es para producción.
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const PORT = Number(process.env.FAKE_PORT || 54321);
const FN_PORT = Number(process.env.FN_PORT || 54400);
const SECRET = 'test-jwt-secret';
const SERVICE_KEY = jwt({ role: 'service_role' }, 10 * 365 * 864e5);
const ANON_KEY = jwt({ role: 'anon' }, 10 * 365 * 864e5);
const pool = new pg.Pool({ host: process.env.PGHOST || '/tmp/pg', port: Number(process.env.PGPORT || 54329), user: 'postgres', database: process.env.PGDATABASE || 'nautica_e2e', max: 8 });

function b64u(b) { return Buffer.from(b).toString('base64url'); }
function jwt(claims, ms = 3600e3) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({ iat: now, exp: now + Math.floor(ms / 1000), aud: 'authenticated', ...claims }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verificar(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(b, 'base64url').toString());
  return c.exp * 1000 > Date.now() ? c : null;
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*' };
function send(res, status, data, extra = {}) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json', ...extra });
  res.end(data === undefined ? '' : JSON.stringify(data));
}
async function leer(req) { const ch = []; for await (const c of req) ch.push(c); return Buffer.concat(ch); }

async function comoRol(claims, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const rol = claims?.role === 'service_role' ? 'service_role' : claims?.sub ? 'authenticated' : 'anon';
    if (claims?.sub) await c.query("select set_config('test.uid', $1, true)", [claims.sub]);
    await c.query(`set local role ${rol}`);
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

const usuarioJSON = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta || {}, app_metadata: {}, created_at: new Date().toISOString() });
function sesion(u) {
  const access = jwt({ sub: u.id, email: u.email, role: 'authenticated', user_metadata: u.meta || {} });
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: crypto.randomUUID(), user: usuarioJSON(u) };
}
const refresh = new Map();

// ---------- PostgREST mínimo ----------
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error('identificador inválido ' + s); return `"${s}"`; };
function filtros(params) {
  const where = []; const vals = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
    const m = v.match(/^(eq|neq|in|is|gt|lt|gte|lte)\.(.*)$/);
    if (!m) continue;
    const col = ident(k);
    if (m[1] === 'eq') { vals.push(m[2]); where.push(`${col}::text = $${vals.length}`); }
    else if (m[1] === 'neq') { vals.push(m[2]); where.push(`${col}::text <> $${vals.length}`); }
    else if (m[1] === 'is') where.push(`${col} is ${m[2] === 'null' ? 'null' : m[2] === 'true' ? 'true' : 'false'}`);
    else if (m[1] === 'in') { vals.push(m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); where.push(`${col}::text = any($${vals.length})`); }
  }
  return { where: where.length ? 'where ' + where.join(' and ') : '', vals };
}

async function rest(req, res, claims, url) {
  const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return send(res, 404, { message: 'no encontrado' });
  const body = ['POST', 'PATCH'].includes(req.method) ? JSON.parse((await leer(req)).toString() || '{}') : null;
  try {
    if (m[1]) {
      const args = Object.entries(body || {});
      const sql = `select ${ident('public')}.${ident(m[2])}(${args.map(([k], i) => `${ident(k)} => $${i + 1}`).join(', ')}) as r`;
      const vals = args.map(([, v]) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
      const r = await comoRol(claims, (c) => c.query(sql, vals));
      return send(res, 200, r.rows[0].r);
    }
    const tabla = `public.${ident(m[2])}`;
    const { where, vals } = filtros(url.searchParams);
    const unico = /vnd\.pgrst\.object/.test(req.headers.accept || '');
    if (req.method === 'GET') {
      const cols = (url.searchParams.get('select') || '*').split(',').map((c) => (c === '*' ? '*' : ident(c.trim()))).join(', ');
      const order = url.searchParams.get('order') ? 'order by ' + url.searchParams.get('order').split(',').map((o) => { const [c, d] = o.split('.'); return `${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ') : '';
      const r = await comoRol(claims, (c) => c.query(`select ${cols} from ${tabla} ${where} ${order}`, vals));
      if (unico) return r.rows.length === 1 ? send(res, 200, r.rows[0]) : send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${r.rows.length} rows` });
      return send(res, 200, r.rows);
    }
    if (req.method === 'POST') {
      const k = Object.keys(body);
      const r = await comoRol(claims, (c) => c.query(`insert into ${tabla}(${k.map(ident).join(',')}) values (${k.map((_, i) => `$${i + 1}`).join(',')}) returning *`, k.map((x) => body[x])));
      return send(res, 201, r.rows);
    }
    if (req.method === 'PATCH') {
      const k = Object.keys(body);
      const r = await comoRol(claims, (c) => c.query(`update ${tabla} set ${k.map((x, i) => `${ident(x)} = $${i + 1 + vals.length}`).join(', ')} ${where} returning *`, [...vals, ...k.map((x) => body[x])]));
      return send(res, 200, r.rows);
    }
    if (req.method === 'DELETE') { await comoRol(claims, (c) => c.query(`delete from ${tabla} ${where}`, vals)); return send(res, 204); }
  } catch (e) {
    return send(res, e.message.includes('permission denied') ? 403 : 400, { code: e.code, message: e.message, details: null, hint: null });
  }
}

// ---------- GoTrue mínimo ----------
async function auth(req, res, url) {
  const p = url.pathname.replace('/auth/v1', '');
  const body = ['POST', 'PUT'].includes(req.method) ? JSON.parse((await leer(req)).toString() || '{}') : {};
  const claims = verificar((req.headers.authorization || '').replace(/^Bearer /, ''));
  const q = (sql, v) => pool.query(sql, v).then((r) => r.rows);
  if (p === '/token' && url.searchParams.get('grant_type') === 'password') {
    const [u] = await q('select id, email, meta, pass from auth.users where email = $1', [body.email]);
    if (!u || u.pass !== crypto.createHash('sha256').update(body.password || '').digest('hex')) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
    const s = sesion(u); refresh.set(s.refresh_token, u.id); return send(res, 200, s);
  }
  if (p === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const id = refresh.get(body.refresh_token);
    const [u] = await q('select id, email, meta from auth.users where id = $1', [id]);
    if (!u) return send(res, 400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
    const s = sesion(u); refresh.set(s.refresh_token, u.id); return send(res, 200, s);
  }
  if (p === '/user' && req.method === 'GET') {
    if (!claims?.sub) return send(res, 401, { msg: 'invalid JWT', code: 'bad_jwt' });
    const [u] = await q('select id, email, meta from auth.users where id = $1', [claims.sub]);
    return u ? send(res, 200, usuarioJSON(u)) : send(res, 404, { msg: 'User not found' });
  }
  if (p === '/user' && req.method === 'PUT') {
    if (!claims?.sub) return send(res, 401, { msg: 'invalid JWT' });
    if (body.password) await q('update auth.users set pass = $2 where id = $1', [claims.sub, crypto.createHash('sha256').update(body.password).digest('hex')]);
    if (body.data) await q('update auth.users set meta = coalesce(meta, \'{}\') || $2 where id = $1', [claims.sub, body.data]);
    const [u] = await q('select id, email, meta from auth.users where id = $1', [claims.sub]);
    return send(res, 200, usuarioJSON(u));
  }
  if (p === '/logout') return send(res, 204);
  if (p.startsWith('/admin/users')) {
    if (claims?.role !== 'service_role') return send(res, 403, { msg: 'not admin' });
    const id = p.split('/')[3];
    if (req.method === 'POST') {
      const [u] = await q('insert into auth.users(id, email, pass, meta) values (gen_random_uuid(), $1, $2, $3) returning id, email, meta', [body.email, crypto.createHash('sha256').update(body.password).digest('hex'), body.user_metadata || {}]);
      return send(res, 200, usuarioJSON(u));
    }
    if (req.method === 'PUT') {
      if (body.password) await q('update auth.users set pass = $2 where id = $1', [id, crypto.createHash('sha256').update(body.password).digest('hex')]);
      if (body.user_metadata) await q('update auth.users set meta = coalesce(meta, \'{}\') || $2 where id = $1', [id, body.user_metadata]);
      const [u] = await q('select id, email, meta from auth.users where id = $1', [id]);
      return send(res, 200, usuarioJSON(u));
    }
    if (req.method === 'DELETE') { await q('delete from auth.users where id = $1', [id]); return send(res, 200, {}); }
  }
  return send(res, 404, { msg: 'no implementado ' + p });
}

// ---------- Proxy a las Edge Functions (Deno) ----------
async function funciones(req, res, url) {
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await leer(req) : undefined;
  const r = await fetch(`http://127.0.0.1:${FN_PORT}${url.pathname.replace('/functions/v1', '')}${url.search}`, {
    method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k))), body,
  });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url);
    if (url.pathname.startsWith('/functions/v1')) return await funciones(req, res, url);
    const token = (req.headers.authorization || '').replace(/^Bearer /, '') || req.headers.apikey;
    const claims = verificar(token);
    if (url.pathname.startsWith('/rest/v1')) return await rest(req, res, claims, url);
    if (url.pathname.startsWith('/realtime')) { res.writeHead(404); return res.end(); }
    send(res, 404, { message: 'no encontrado' });
  } catch (e) { console.error(e); send(res, 500, { message: e.message }); }
}).listen(PORT, () => console.log(`fake supabase en http://localhost:${PORT}\nANON_KEY=${ANON_KEY}\nSERVICE_KEY=${SERVICE_KEY}`));

export { ANON_KEY, SERVICE_KEY };
