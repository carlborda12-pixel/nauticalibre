// Pruebas de los módulos de las Edge Functions.
// Correr con: DENO_NO_PACKAGE_JSON=1 deno test -A test/funciones.test.ts
import assert from 'node:assert/strict';
import { firmaValida, parsearWebhook, contenido } from '../supabase/functions/_shared/whatsapp.ts';
import { detectar, type Producto } from '../supabase/functions/_shared/catalogo.ts';
import { procesarEntrante } from '../supabase/functions/_shared/entrante.ts';

// Catálogo real (el mismo de la migración)
const sql = await Deno.readTextFile(new URL('../supabase/migrations/20261115000002_catalogo.sql', import.meta.url));
const productos: Producto[] = [...sql.matchAll(/\('((?:[^']|'')+)', '((?:[^']|'')+)', '((?:[^']|'')+)'\)/g)]
  .map((m, i) => ({ id: i + 1, codigo: m[1], nombre: m[2].replace(/''/g, "'"), categoria: m[3] }));

Deno.test('catálogo cargado', () => { assertEqualsN(productos.length, 463); });
function assertEqualsN(a: number, b: number) { assert.equal(a, b); }

Deno.test('firma del webhook de Meta', async () => {
  const body = new TextEncoder().encode('{"hola":1}');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secreto'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = 'sha256=' + [...new Uint8Array(await crypto.subtle.sign('HMAC', key, body))].map((x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(await firmaValida(body, firma, 'secreto'), true);
  assert.equal(await firmaValida(body, firma.replace(/.$/, '0'), 'secreto'), false);
  assert.equal(await firmaValida(body, null, 'secreto'), false);
  assert.equal(await firmaValida(body, firma, ''), false);
});

Deno.test('parseo del webhook: mensajes, estados y ecos', () => {
  const ev = parsearWebhook({ entry: [{ changes: [
    { field: 'messages', value: { contacts: [{ wa_id: '5493764000000', profile: { name: 'Ana' } }],
      messages: [{ from: '5493764000000', id: 'wamid.1', type: 'text', text: { body: 'hola' } }],
      statuses: [{ id: 'wamid.2', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement' }] }] } },
    { field: 'smb_message_echoes', value: { message_echoes: [{ to: '5493764000000', id: 'wamid.3', type: 'text', text: { body: 'te atiendo' } }] } },
  ] }] });
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[0], { kind: 'message', waId: '5493764000000', nombre: 'Ana', msg: { from: '5493764000000', id: 'wamid.1', type: 'text', text: { body: 'hola' } } });
  assert.deepEqual(ev[1], { kind: 'status', waMsgId: 'wamid.2', status: 'failed', error: '131047 Re-engagement' });
  assert.equal(ev[2].kind, 'echo');
  assert.deepEqual(contenido({ type: 'image', image: { id: 'MEDIA1', caption: 'mirá' } }), { tipo: 'image', cuerpo: 'mirá', media: 'MEDIA1' });
});

Deno.test('detección de embarcación y origen', () => {
  const geuna = productos.find((p) => p.nombre === 'GEUNA 540 FULL')!;
  let d = detectar(`Hola! Quiero información sobre: GEUNA 540 FULL (ref ${geuna.codigo}-IGH)`, null, productos);
  assert.equal(d.producto?.nombre, 'GEUNA 540 FULL');
  assert.equal(d.origen, 'Instagram historia');
  d = detectar('precio eclipse 19?', null, productos);
  assert.match(d.producto!.nombre, /^ECLIPSE 19/);
  assert.equal(d.via, 'nombre');
  d = detectar('Hola!', { source_type: 'ad', headline: 'Bermuda 180 Sport en oferta' }, productos);
  assert.equal(d.origen, 'Anuncio Meta');
  assert.equal(d.producto?.nombre, 'BERMUDA 180 SPORT');
  assert.equal(detectar('hola buenas', null, productos).producto, null);
});

Deno.test('procesarEntrante arma bien la llamada a la base y manda la bienvenida simulada', async () => {
  const llamadas: { fn: string; args: Record<string, unknown> }[] = [];
  const sb = {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: productos, error: null }) }) }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      llamadas.push({ fn, args });
      if (fn === 'procesar_entrante') return Promise.resolve({ data: { lead_id: 7, nuevo: true, wa_id: '5493514111111', bienvenida: 'Hola!' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  const fishing = productos.find((p) => p.nombre === 'FISHING 6.0')!;
  // deno-lint-ignore no-explicit-any
  const r = await procesarEntrante(sb as any, { waId: '5493514111111', nombre: 'Ana', msg: { id: 'wamid.9', type: 'text', timestamp: '1794000000', text: { body: `info FISHING 6.0 (ref ${fishing.codigo}-FB)` } } });
  assert.equal(r.lead_id, 7);
  // deno-lint-ignore no-explicit-any
  const p = (llamadas[0].args as any).p;
  assert.equal(p.producto_id, fishing.id);
  assert.equal(p.origen, 'Facebook publicación');
  assert.equal(p.ts, 1794000000000);
  assert.equal(llamadas[1].fn, 'registrar_salida');
  assert.equal(llamadas[1].args.p_tipo, 'auto');
  assert.equal(llamadas[1].args.p_estado, 'simulado'); // sin WA_TOKEN no se envía nada real
});
