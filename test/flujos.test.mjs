// Pruebas de las reglas de negocio contra un Postgres real.
// Requiere un Postgres local: PGHOST=/tmp/pg PGPORT=54329 npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const cfg = { host: process.env.PGHOST || '/tmp/pg', port: Number(process.env.PGPORT || 54329), user: 'postgres' };
const DB = 'nautica_test';
let db;
const U = {};
const MIN = 60e3;

async function sql(q, params = []) { return (await db.query(q, params)).rows; }

// Ejecuta como un usuario del panel (rol authenticated + auth.uid())
async function como(usuario, q, params = []) {
  await db.query('begin');
  try {
    await db.query("select set_config('test.uid', $1, true)", [U[usuario]]);
    await db.query('set local role authenticated');
    const r = await db.query(q, params);
    await db.query('commit');
    return r.rows;
  } catch (e) { await db.query('rollback'); throw e; }
}
// Como la Edge Function (service_role)
async function servicio(q, params = []) {
  await db.query('begin');
  try {
    await db.query('set local role service_role');
    const r = await db.query(q, params);
    await db.query('commit');
    return r.rows;
  } catch (e) { await db.query('rollback'); throw e; }
}

let n = 0;
const entra = async (wa, texto, extra = {}) => (await servicio('select public.procesar_entrante($1) r', [{
  wa_id: wa, nombre: extra.nombre ?? null, msg_id: `t-${++n}`, tipo: 'text', cuerpo: texto, ts: Date.now(), ...extra,
}]))[0].r;
const lead = async (id) => (await sql('select * from leads where id = $1', [id]))[0];
const tick = async (masMin) => (await servicio("select public.tick(now() + make_interval(mins => $1)) r", [masMin]))[0].r;

before(async () => {
  const admin = new pg.Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  db = new pg.Client({ ...cfg, database: DB });
  await db.connect();
  await db.query("set client_min_messages = warning");
  for (const f of ['test/bootstrap.sql', 'supabase/migrations/20261115000001_esquema.sql', 'supabase/migrations/20261115000002_catalogo.sql']) {
    await db.query(readFileSync(f, 'utf8'));
  }
  for (const [usuario, nombre, rol, recibe] of [
    ['juanchi', 'Juanchi', 'vendedor', true], ['jorge', 'Jorge', 'vendedor', true], ['cristian', 'Cristian', 'vendedor', true],
    ['gerencia', 'Gerencia', 'admin', false], ['admin', 'Administración', 'admin', false]]) {
    const [{ id }] = await sql('insert into auth.users(id, email) values (gen_random_uuid(), $1) returning id', [`${usuario}@nautica.local`]);
    await sql('insert into perfiles(id, nombre, usuario, rol, recibe_leads) values ($1,$2,$3,$4,$5)', [id, nombre, usuario, rol, recibe]);
    U[usuario] = id;
  }
  await sql(`update ajustes set valor = '{"activo": false, "dias": [], "desde": "08:00", "hasta": "20:00"}' where clave = 'horario'`);
});
after(async () => { await db?.end(); });

test('un usuario sin sesión no puede llamar a nada', async () => {
  await db.query('begin');
  await db.query('set local role anon');
  await assert.rejects(db.query("select public.listar_leads('pool','')"), /permission denied/);
  await db.query('rollback');
  await assert.rejects(como('juanchi', "select public.procesar_entrante('{}')"), /permission denied/);
  await assert.rejects(como('juanchi', 'select public.tick()'), /permission denied/);
});

test('lead de zona neutral cae a la bolsa; el primero que toma se lo queda', async () => {
  const p = (await sql("select id from catalogo where nombre = 'ECLIPSE 21 SR'"))[0];
  const r = await entra('5493514111111', 'Hola, info de la ECLIPSE 21 SR', { nombre: 'Ana Córdoba', producto_id: p.id, origen: 'Instagram publicación' });
  assert.equal(r.nuevo, true);
  assert.equal(r.estado, 'pendiente');
  const pool = (await como('juanchi', "select public.listar_leads('pool','') r"))[0].r;
  assert.ok(pool.leads.some((l) => l.id === r.lead_id && l.producto === 'ECLIPSE 21 SR'));
  await como('cristian', 'select public.tomar_lead($1)', [r.lead_id]);
  await assert.rejects(como('juanchi', 'select public.tomar_lead($1)', [r.lead_id]), /Ya lo tomó Cristian/);
  await assert.rejects(como('juanchi', 'select public.ver_lead($1)', [r.lead_id]), /otro vendedor/);
  // RLS directa (lo que usa Realtime): Juanchi no ve la fila, Cristian y gerencia sí
  assert.equal((await como('juanchi', 'select count(*)::int n from leads where id = $1', [r.lead_id]))[0].n, 0);
  assert.equal((await como('cristian', 'select count(*)::int n from leads where id = $1', [r.lead_id]))[0].n, 1);
  assert.equal((await como('gerencia', 'select count(*)::int n from mensajes where lead_id = $1', [r.lead_id]))[0].n, 1);
});

test('si el que tomó no responde a tiempo, vuelve a la bolsa y se avisa', async () => {
  const [{ id }] = await sql("select l.id from leads l join contactos c on c.id = l.contacto_id where c.wa_id = '5493514111111'");
  assert.equal((await tick(19)).liberados, 0);
  assert.equal((await tick(21)).liberados, 1);
  const l = await lead(id);
  assert.equal(l.estado, 'pendiente');
  assert.equal(l.asignado_a, null);
  const ev = await sql("select detalle from eventos where lead_id = $1 and tipo = 'liberado_timeout'", [id]);
  assert.match(ev[0].detalle, /Cristian no respondió/);
  const notif = await sql("select titulo, destinatarios from notificaciones where titulo like '⏰%' order by id");
  assert.ok(notif.some((x) => x.titulo.includes('Sin respuesta de Cristian') && !x.destinatarios.includes(U.cristian)));
});

test('responder desde la bolsa toma el lead y deja al vendedor como titular', async () => {
  const [{ id }] = await sql("select l.id from leads l join contactos c on c.id = l.contacto_id where c.wa_id = '5493514111111'");
  const prep = (await servicio('select public.preparar_envio($1, $2) r', [id, U.juanchi]))[0].r;
  assert.equal(prep.wa_id, '5493514111111');
  await servicio("select public.registrar_salida($1, $2, 'Hola Ana!', 'wamid.X1', 'sent')", [id, U.juanchi]);
  const l = await lead(id);
  assert.equal(l.estado, 'asignado');
  assert.equal(l.asignado_a, U.juanchi);
  assert.equal(l.primera_respuesta_por, U.juanchi);
  assert.equal(l.vence_at, null);
  const [c] = await sql('select titular_id from contactos where wa_id = $1', ['5493514111111']);
  assert.equal(c.titular_id, U.juanchi);
  assert.equal((await tick(90)).liberados, 0);
  // estado de entrega no retrocede
  await servicio("select public.procesar_estado('wamid.X1', 'read')");
  await servicio("select public.procesar_estado('wamid.X1', 'delivered')");
  assert.equal((await sql("select estado from mensajes where wa_msg_id = 'wamid.X1'"))[0].estado, 'read');
});

test('venta; si el cliente vuelve a escribir va directo a su titular', async () => {
  const [{ id }] = await sql("select l.id from leads l join contactos c on c.id = l.contacto_id where c.wa_id = '5493514111111'");
  await assert.rejects(como('juanchi', "select public.cerrar_lead($1, 'vendido', 0)", [id]), /monto/);
  await assert.rejects(como('jorge', "select public.cerrar_lead($1, 'vendido', 100)", [id]), /otro vendedor/);
  await como('juanchi', "select public.cerrar_lead($1, 'vendido', 18500)", [id]);
  const r = await entra('5493514111111', 'Hola Juanchi, consulta por el service');
  assert.notEqual(r.lead_id, id);
  const l = await lead(r.lead_id);
  assert.equal(l.estado, 'asignado');
  assert.equal(l.motivo_asignacion, 'titular');
  assert.equal(l.asignado_a, U.juanchi);
});

test('Posadas (376) va al titular de zona; si no responde, a la bolsa', async () => {
  const r = await entra('5493764123456', 'Hola quiero info del G1 165');
  const l = await lead(r.lead_id);
  assert.equal(l.asignado_a, U.jorge);
  assert.equal(l.motivo_asignacion, 'zona Posadas');
  await tick(25);
  assert.equal((await lead(r.lead_id)).estado, 'pendiente');
});

test('si nadie toma la consulta, alerta a gerencia una sola vez', async () => {
  const r = await entra('5491155554444', 'Hola');
  assert.equal(r.estado, 'pendiente');
  assert.ok((await tick(21)).alertas >= 1);
  assert.equal((await tick(22)).alertas, 0);
});

test('mensajes duplicados de Meta se ignoran', async () => {
  const a = await entra('5491100000000', 'hola', { msg_id: 'wamid.DUP' });
  const b = await entra('5491100000000', 'hola', { msg_id: 'wamid.DUP' });
  assert.ok(a.lead_id);
  assert.equal(b.duplicado, true);
});

test('el reloj respeta el horario de atención', async () => {
  const h = { activo: true, dias: [1, 2, 3, 4, 5, 6], desde: '08:00', hasta: '20:00' };
  const [{ v }] = await sql("select public.vencimiento('2026-11-16 23:00-03', 20, $1) v", [h]); // domingo 23:00
  assert.equal(v.toISOString(), '2026-11-17T11:20:00.000Z'); // lunes 08:20 AR
  const [{ w }] = await sql("select public.vencimiento('2026-11-14 19:50-03', 20, $1) w", [h]); // sábado 19:50
  assert.equal(w.toISOString(), '2026-11-16T11:10:00.000Z'); // lunes 08:10 AR
});

test('no se puede escribir fuera de la ventana de 24 h', async () => {
  const r = await entra('5493624000000', 'Hola, consulta');
  await sql("update leads set ultimo_in_at = now() - interval '25 hours' where id = $1", [r.lead_id]);
  await assert.rejects(servicio('select public.preparar_envio($1, $2)', [r.lead_id, U.juanchi]), /24 h/);
});

test('la bienvenida automática no cuenta como respuesta', async () => {
  await sql(`update ajustes set valor = '{"activo": true, "texto": "Hola! Ya te atendemos."}' where clave = 'bienvenida'`);
  const r = await entra('5493511231234', 'Hola');
  assert.equal(r.bienvenida, 'Hola! Ya te atendemos.');
  await servicio("select public.registrar_salida($1, null, 'Hola! Ya te atendemos.', 'wamid.AUTO', 'sent', 'auto')", [r.lead_id]);
  assert.equal((await lead(r.lead_id)).primera_respuesta_at, null);
  await sql(`update ajustes set valor = '{"activo": false, "texto": ""}' where clave = 'bienvenida'`);
});

test('notas, etapa, producto y datos del cliente', async () => {
  const r = await entra('5493512223333', 'hola');
  await como('cristian', 'select public.tomar_lead($1)', [r.lead_id]);
  await como('cristian', "select public.agregar_nota($1, 'Llamar a la tarde')", [r.lead_id]);
  const [{ id: pid }] = await sql("select id from catalogo where nombre = 'FISHING 6.0'");
  await como('cristian', 'select public.actualizar_lead($1, $2)', [r.lead_id, { etapa: 'Presupuesto enviado', producto_id: pid, nombre: 'Pedro', localidad: 'Oberá' }]);
  await assert.rejects(como('cristian', 'select public.actualizar_lead($1, $2)', [r.lead_id, { etapa: 'Inventada' }]), /Etapa inválida/);
  const v = (await como('cristian', 'select public.ver_lead($1) r', [r.lead_id]))[0].r;
  assert.equal(v.lead.etapa, 'Presupuesto enviado');
  assert.equal(v.lead.producto, 'FISHING 6.0');
  assert.equal(v.contacto.nombre, 'Pedro');
  assert.equal(v.contacto.localidad, 'Oberá');
  assert.ok(v.mensajes.some((m) => m.direccion === 'nota' && m.autor === 'Cristian'));
});

test('métricas y exportación solo para gerencia', async () => {
  await assert.rejects(como('juanchi', 'select public.metricas()'), /Solo gerencia/);
  const m = (await como('gerencia', 'select public.metricas() r'))[0].r;
  assert.ok(m.totales.leads >= 5);
  assert.equal(m.totales.vendidos, 1);
  assert.equal(Number(m.totales.monto_usd), 18500);
  const j = m.porVendedor.find((v) => v.nombre === 'Juanchi');
  assert.equal(j.vendidos, 1);
  assert.equal(m.porVendedor.find((v) => v.nombre === 'Cristian').timeouts, 1);
  assert.ok(m.porOrigen.some((o) => o.nombre === 'Instagram publicación'));
  assert.ok(m.porDia.length >= 1);
  const ex = (await como('admin', 'select public.exportar_leads() r'))[0].r;
  assert.ok(ex.length >= 5 && ex[0].length === 18);
});

test('ajustes y usuarios', async () => {
  await assert.rejects(como('jorge', "select public.guardar_ajustes('{\"minutos_respuesta\": 5}')"), /Solo gerencia/);
  await como('gerencia', 'select public.guardar_ajustes($1)', [{
    minutos_respuesta: 15, horario: { activo: true, dias: ['1', '2', 9], desde: '09:00', hasta: '19:00' },
    zonas: { activo: true, lista: [{ nombre: 'Posadas', prefijos: '376, 3764', titular: 'Jorge' }, { nombre: '', prefijos: '1' }] },
  }]);
  const a = (await como('gerencia', 'select public.admin_ajustes() r'))[0].r;
  assert.equal(a.minutos_respuesta, 15);
  assert.deepEqual(a.horario.dias, [1, 2]);
  assert.deepEqual(a.zonas.lista, [{ nombre: 'Posadas', prefijos: ['376', '3764'], titular: 'Jorge' }]);
  await assert.rejects(como('gerencia', "select public.admin_actualizar_usuario($1, '{\"activo\": false}')", [U.gerencia]), /vos mismo/);
  // desactivar a un vendedor libera sus consultas abiertas
  const r = await entra('5493516667777', 'hola');
  await como('jorge', 'select public.tomar_lead($1)', [r.lead_id]);
  await como('gerencia', "select public.admin_actualizar_usuario($1, '{\"activo\": false}')", [U.jorge]);
  assert.equal((await lead(r.lead_id)).estado, 'pendiente');
  await como('gerencia', "select public.admin_actualizar_usuario($1, '{\"activo\": true}')", [U.jorge]);
  const cfg = (await como('jorge', 'select public.mi_config() r'))[0].r;
  assert.equal(cfg.user.nombre, 'Jorge');
  assert.equal(cfg.minutos, 15);
});

test('coexistencia: respuesta desde el celular detiene el reloj', async () => {
  const r = await entra('5493519998888', 'hola');
  await servicio('select public.procesar_eco($1)', [{ wa_id: '5493519998888', msg_id: 'wamid.ECO', tipo: 'text', cuerpo: 'Hola! te atiendo' }]);
  const l = await lead(r.lead_id);
  assert.ok(l.primera_respuesta_at);
  assert.equal(l.vence_at, null);
});
