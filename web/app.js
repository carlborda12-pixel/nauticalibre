'use strict';
/* Náutica Aire Libre · Leads — panel web (JS plano, sin build). ApexTech */

const S = {
  me: null, cfg: null, vista: 'pool', q: '', leads: [], counts: {}, sel: null, det: null,
  catalogo: [], porCodigo: new Map(), skew: 0, nota: false, prevPool: null, prevUnread: null, renderedLead: null,
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ahora = () => Date.now() + S.skew;
const esAdmin = () => S.me?.rol === 'admin';

// ---------- DOM helper (todo el texto va por textContent: sin inyección) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // vía CSSOM: compatible con la CSP (sin estilos inline)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- API ----------
// Toda la comunicación pasa por backend.js (Supabase)
async function api(method, path, body) {
  let data;
  try { data = await window.backend.api(method, path, body); }
  catch (e) {
    if (e instanceof window.backend.SesionVencida && path !== '/login') { mostrarLogin(); throw new Error('Sesión vencida'); }
    throw e;
  }
  if (data && data.ahora) S.skew = data.ahora - Date.now();
  return data ?? { ok: true };
}

let toastT;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast'; }, err ? 5000 : 2600);
}
const intentar = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Sesión vencida') toast(e.message, true); } };

// ---------- Formatos ----------
const pad = (n) => String(n).padStart(2, '0');
const hora = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fecha = (t) => new Date(t).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
const diaLargo = (t) => {
  const d = new Date(t); const hoy = new Date();
  const ayer = new Date(); ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString()) return 'Hoy';
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
};
function hace(t) {
  const s = Math.max(0, (ahora() - t) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return hora(t);
  if (s < 7 * 86400) return new Date(t).toLocaleDateString('es-AR', { weekday: 'short' });
  return fecha(t);
}
function reloj(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000);
  const txt = m >= 60 ? `${Math.floor(m / 60)} h ${pad(m % 60)}` : `${pad(m)}:${pad(s)}`;
  return neg ? `+${txt}` : txt;
}
const usd = (n) => `USD ${Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const minTxt = (m) => (m == null ? '—' : m < 1 ? '< 1 min' : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`);
const telFmt = (wa) => { const d = String(wa || '').replace(/^549/, ''); return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6)}` : `+${wa}`; };

// ---------- Diálogo ----------
function dialogo({ titulo, cuerpo = [], ok = 'Aceptar', cancelar = 'Cancelar', peligro = false }) {
  const dlg = $('#dlg'); const form = $('#dlg-form');
  form.replaceChildren(
    h('h3', null, titulo), ...cuerpo,
    h('div', { class: 'actions' },
      cancelar && h('button', { class: 'btn', value: 'cancel', type: 'submit', formnovalidate: true }, cancelar),
      h('button', { class: `btn ${peligro ? 'btn-danger' : 'btn-primary'}`, value: 'ok', type: 'submit' }, ok)),
  );
  dlg.showModal();
  setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? new FormData(form) : null), { once: true });
  });
}

// ---------- Sesión ----------
function mostrarLogin() {
  $('#v-app').hidden = true; $('#v-login').hidden = false;
  window.backend.cerrarRealtime(); S.rt = false;
  setTimeout(() => $('#f-login [name=usuario]').focus(), 30);
  accesoDemo();
}

// En la demostración: se entra directo como Gerencia, sin clave
let demoInfo = null;
async function infoDemo() {
  if (demoInfo) return demoInfo;
  try { demoInfo = await window.backend.api('GET', '/demo-info'); } catch { demoInfo = { demo: false }; }
  return demoInfo;
}
async function cambiarUsuarioDemo(usuario) {
  const info = await infoDemo();
  await api('POST', '/login', { usuario, clave: info.clave });
  S.rt = false; S.sel = null; S.prevPool = null; S.prevUnread = null; S.renderedLead = null;
  if (location.hash && location.hash !== '#bandeja') location.hash = 'bandeja';
  await iniciar();
}
async function accesoDemo() {
  const box = $('#demo-access');
  const info = await infoDemo();
  if (!info?.demo) { box.hidden = true; return; }
  if (!sessionStorage.getItem('nal_salio')) { try { await cambiarUsuarioDemo('gerencia'); return; } catch { /* muestra los botones */ } }
  const entrar = intentar(async (usuario) => {
    await api('POST', '/login', { usuario, clave: info.clave });
    await iniciar();
  });
  box.replaceChildren(
    h('p', null, h('b', null, 'Demostración. '), 'Entrá con un clic como:'),
    h('div', { class: 'grid' }, info.usuarios.map((u) => h('button', { class: 'btn', type: 'button', onclick: () => entrar(u.usuario) },
      u.nombre, ' ', h('small', null, u.rol === 'admin' ? '(gerencia)' : '(vendedor)')))),
    h('a', { class: 'cli', href: '/cliente.html', target: '_blank', rel: 'noopener' }, '📱 Abrir el simulador de cliente (escribí como comprador)'),
  );
  box.hidden = false;
}

$('#f-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('POST', '/login', { usuario: fd.get('usuario'), clave: fd.get('clave') });
    e.target.reset();
    await iniciar();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#btn-logout').addEventListener('click', intentar(async () => { await api('POST', '/logout'); try { sessionStorage.setItem('nal_salio', '1'); } catch { /* sin almacenamiento */ } mostrarLogin(); }));
$('#btn-clave').addEventListener('click', () => cambiarClave(false));

async function cambiarClave(obligatorio) {
  const fd = await dialogo({
    titulo: obligatorio ? 'Elegí tu clave personal' : 'Cambiar clave',
    cuerpo: [
      obligatorio && h('p', { class: 'muted' }, 'Es tu primer ingreso. Cambiá la clave inicial por una que solo sepas vos (mínimo 8 caracteres).'),
      h('label', null, 'Clave actual', h('input', { name: 'actual', type: 'password', required: true, autocomplete: 'current-password' })),
      h('label', null, 'Clave nueva', h('input', { name: 'nueva', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    ],
    ok: 'Guardar', cancelar: obligatorio ? null : 'Cancelar',
  });
  if (!fd) return;
  try {
    await api('POST', '/me/clave', { actual: fd.get('actual'), nueva: fd.get('nueva') });
    toast('Clave actualizada.');
    S.me.debe_cambiar_pass = false;
  } catch (e) { toast(e.message, true); if (obligatorio) cambiarClave(true); }
}

async function iniciar() {
  let me;
  try { me = await api('GET', '/me'); } catch { return; }
  S.me = me.user; S.cfg = me;
  $('#v-login').hidden = true; $('#v-app').hidden = false;
  $('#user-name').textContent = `${S.me.nombre} ▾`;
  $('#demo-badge').hidden = !me.demo;
  $('#demo-cliente').hidden = !me.demoMode;
  $('#demo-ver').hidden = !me.demoMode;
  if (me.demoMode) {
    const info = await infoDemo();
    const sel = $('#demo-user');
    sel.replaceChildren(...(info.usuarios || []).map((u) => h('option', { value: u.usuario, selected: u.nombre === S.me.nombre }, `${u.nombre}${u.rol === 'admin' ? ' (gerencia)' : ' (vendedor)'}`)));
    sel.onchange = intentar(async () => { await cambiarUsuarioDemo(sel.value); toast(`Ahora ves el sistema como ${S.me.nombre}.`); });
  }
  for (const el of $$('[data-admin]')) el.hidden = !esAdmin();
  if (!S.catalogo.length) {
    const { productos } = await api('GET', '/catalogo');
    S.catalogo = productos;
    S.porCodigo = new Map(productos.map((p) => [p.codigo, p]));
    $('#dl-productos').replaceChildren(...productos.map((p) => h('option', { value: `${p.codigo} · ${p.nombre}` }, p.categoria)));
  }
  conectarStream();
  prepararPush();
  if (S.me.debe_cambiar_pass) cambiarClave(true);
  if (!esAdmin() && S.vista === 'todos') S.vista = 'pool';
  ruta();
}

// ---------- Rutas ----------
window.addEventListener('hashchange', ruta);
function ruta() {
  if (!S.me) return;
  const hsh = location.hash.slice(1) || 'bandeja';
  let [tab, id] = hsh.split('/');
  if (tab === 'lead') { S.sel = Number(id) || null; tab = 'bandeja'; } else if (tab === 'bandeja') S.sel = null;
  if ((tab === 'metricas' || tab === 'config') && !esAdmin()) tab = 'bandeja';
  if (!['bandeja', 'metricas', 'links', 'config'].includes(tab)) tab = 'bandeja';
  for (const a of $$('#tabs a')) a.classList.toggle('active', a.dataset.tab === tab);
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  if (tab === 'bandeja') { cargarLista(); if (S.sel) abrirLead(S.sel); else cerrarDetalle(); }
  if (tab === 'metricas') iniciarMetricas();
  if (tab === 'links') iniciarLinks();
  if (tab === 'config') cargarConfig();
}

// ---------- Tiempo real ----------
function conectarStream() {
  if (S.rt) return;
  S.rt = true;
  window.backend.realtime((id) => programarRefresco(id)).catch(() => { S.rt = false; });
}
let refT = null; const pendientesRef = new Set();
function programarRefresco(id) {
  pendientesRef.add(id);
  clearTimeout(refT);
  refT = setTimeout(() => {
    const ids = [...pendientesRef]; pendientesRef.clear();
    if ($('[data-panel=bandeja]').hidden) return;
    cargarLista();
    if (S.sel && (ids.includes(S.sel) || ids.includes(0))) abrirLead(S.sel, { silencioso: true });
  }, 250);
}

// ---------- Sonido y título ----------
let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.4);
  } catch { /* sin audio */ }
}
function actualizarTitulo() {
  const n = (S.counts.pool || 0) + (S.counts.mios_no_leidos || 0);
  document.title = `${n ? `(${n}) ` : ''}Náutica Aire Libre · Leads`;
}

// ---------- Lista ----------
$$('#vistas button').forEach((b) => b.addEventListener('click', () => { S.vista = b.dataset.vista; cargarLista(); }));
let qT;
$('#q').addEventListener('input', (e) => { clearTimeout(qT); qT = setTimeout(() => { S.q = e.target.value.trim(); cargarLista(); }, 250); });

const cargarLista = intentar(async () => {
  const data = await api('GET', `/leads?vista=${S.vista}&q=${encodeURIComponent(S.q)}`);
  S.leads = data.leads; S.counts = data.counts;
  if (S.prevPool != null && data.counts.pool > S.prevPool) beep();
  else if (S.prevUnread != null && data.counts.mios_no_leidos > S.prevUnread) beep();
  S.prevPool = data.counts.pool; S.prevUnread = data.counts.mios_no_leidos;
  renderLista();
  actualizarTitulo();
});

function badgeReloj(l) {
  if (l.estado === 'pendiente') {
    const resta = (l.vence_at || l.created_at) - ahora();
    return h('span', { class: `badge ${resta < 0 ? 'badge-crit' : 'badge-warn'}`, dataset: { vence: l.vence_at || '', modo: 'pool' } }, resta < 0 ? `Sin atender ${reloj(resta)}` : `Sin tomar · ${reloj(resta)}`);
  }
  if (l.estado === 'asignado' && !l.primera_respuesta_at && l.vence_at) {
    const resta = l.vence_at - ahora();
    return h('span', { class: `badge ${resta < 5 * 60e3 ? 'badge-crit' : 'badge-warn'}`, dataset: { vence: l.vence_at, modo: 'resp' } }, `Responder · ${reloj(resta)}`);
  }
  if (l.resultado === 'vendido') return h('span', { class: 'badge badge-good' }, `Vendido ${usd(l.monto_usd)}`);
  if (l.resultado === 'perdido') return h('span', { class: 'badge' }, 'Perdido');
  return null;
}

function previewTexto(l) {
  if (!l.ultimo_texto && !l.ultimo_tipo) return '';
  const pre = l.ultimo_dir === 'out' ? '↩ ' : '';
  if (l.ultimo_tipo && !['text', 'auto', 'template'].includes(l.ultimo_tipo)) return `${pre}[${l.ultimo_tipo}] ${l.ultimo_texto || ''}`;
  return pre + (l.ultimo_texto || '');
}

function renderLista() {
  for (const b of $$('#vistas button')) b.classList.toggle('active', b.dataset.vista === S.vista);
  $('#c-pool').textContent = S.counts.pool ?? 0;
  $('#c-pool').classList.toggle('hot', (S.counts.pool || 0) > 0);
  $('#c-mios').textContent = S.counts.mios ?? 0;
  $('#c-mios').classList.toggle('hot', (S.counts.mios_no_leidos || 0) > 0);
  $('#c-todos').textContent = S.counts.todos ?? 0;
  const ul = $('#lista');
  if (!S.leads.length) {
    const vacio = { pool: 'No hay consultas sin tomar. 👌', mios: 'No tenés consultas abiertas.', todos: 'No hay consultas abiertas.', cerrados: 'Todavía no hay consultas cerradas.' };
    ul.replaceChildren(h('li', { class: 'list-empty' }, S.q ? 'Sin resultados.' : vacio[S.vista]));
    return;
  }
  ul.replaceChildren(...S.leads.map((l) => h('li', {
    class: `lead-item${l.id === S.sel ? ' sel' : ''}${l.no_leidos && (l.asignado_a === S.me.id) ? ' unread' : ''}`,
    onclick: () => { location.hash = `lead/${l.id}`; },
    tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter') location.hash = `lead/${l.id}`; },
  },
  h('span', { class: 'nm' }, l.nombre || telFmt(l.wa_id)),
  h('span', { class: 'tm' }, hace(l.ultimo_in_at || l.created_at)),
  h('span', { class: 'pv' }, previewTexto(l)),
  h('span', { class: 'meta' },
    badgeReloj(l),
    l.producto ? h('span', { class: 'badge badge-blue', title: l.producto }, l.producto.length > 28 ? l.producto.slice(0, 27) + '…' : l.producto) : h('span', { class: 'badge' }, 'Sin producto'),
    h('span', { class: 'badge' }, l.origen),
    esAdmin() && l.asignado_nombre && h('span', { class: 'badge', title: 'Asignado a' }, `👤 ${l.asignado_nombre}`)),
  )));
}

// Relojes en vivo
setInterval(() => {
  for (const el of $$('[data-vence]')) {
    const v = Number(el.dataset.vence); if (!v) continue;
    const resta = v - ahora();
    if (el.dataset.modo === 'pool') {
      el.textContent = resta < 0 ? `Sin atender ${reloj(resta)}` : `Sin tomar · ${reloj(resta)}`;
      el.className = `badge ${resta < 0 ? 'badge-crit' : 'badge-warn'}`;
    } else if (el.dataset.modo === 'resp') {
      el.textContent = resta < 0 ? 'Vuelve a la bolsa…' : `Responder · ${reloj(resta)}`;
      el.className = `badge ${resta < 5 * 60e3 ? 'badge-crit' : 'badge-warn'}`;
    } else if (el.dataset.modo === 'banner') {
      el.textContent = resta < 0 ? 'se terminó el tiempo' : reloj(resta);
    }
  }
}, 1000);

// ---------- Detalle ----------
function cerrarDetalle() {
  S.sel = null; S.det = null; S.renderedLead = null;
  $('#t-bandeja').classList.remove('has-detail');
  $('#detalle').replaceChildren(h('div', { class: 'empty' },
    h('p', { class: 'empty-title' }, 'Elegí una consulta'),
    h('p', null, 'Las consultas nuevas aparecen en ', h('b', null, 'Sin tomar'), '. El primero que la toma o responde se la queda.')));
  renderLista();
}

async function abrirLead(id, { silencioso = false } = {}) {
  try {
    S.det = await api('GET', `/leads/${id}`);
    S.sel = id;
    $('#t-bandeja').classList.add('has-detail');
    renderDetalle();
    renderLista();
  } catch (e) {
    const perdido = /otro vendedor|No existe/.test(e.message);
    if (!silencioso || perdido) toast(perdido && silencioso ? 'Otro vendedor tomó esta consulta.' : e.message, true);
    if (perdido) location.hash = 'bandeja';
  }
}

const puedoEditar = () => { const l = S.det.lead; return esAdmin() || (l.estado === 'asignado' && l.asignado_a === S.me.id); };
const puedoEscribir = () => { const l = S.det.lead; return l.estado === 'pendiente' || puedoEditar(); };

function renderDetalle() {
  const d = S.det; const l = d.lead;
  const cont = $('#detalle');
  if (S.renderedLead !== l.id) {
    S.nota = false;
    cont.replaceChildren(
      h('div', { class: 'chat' },
        h('div', { class: 'chat-head', id: 'd-head' }),
        h('div', { id: 'd-banners' }),
        h('div', { class: 'msgs', id: 'd-msgs' }),
        h('div', { id: 'd-composer' })),
      h('aside', { class: 'side', id: 'd-side' }));
    S.renderedLead = l.id;
    renderComposer(true);
  } else {
    renderComposer(false);
  }
  renderHead(); renderBanners(); renderMensajes();
  if (!$('#d-side').contains(document.activeElement)) renderSide();
}

function renderHead() {
  const l = S.det.lead; const c = S.det.contacto;
  const acciones = [];
  if (l.estado === 'pendiente') acciones.push(h('button', { class: 'btn btn-primary', onclick: intentar(async () => { await api('POST', `/leads/${l.id}/tomar`); toast('¡Es tuya! Respondé antes de que corra el reloj.'); abrirLead(l.id); }) }, '✋ Tomar'));
  if (l.estado === 'asignado' && puedoEditar()) {
    acciones.push(h('button', { class: 'btn btn-good', onclick: marcarVenta }, '🎉 Vendido'));
    acciones.push(h('button', { class: 'btn', onclick: marcarPerdido }, 'Perdido'));
    acciones.push(h('button', { class: 'btn', onclick: liberarLead, title: 'Devolver a la bolsa' }, 'Liberar'));
  }
  if (esAdmin() && l.estado !== 'cerrado') acciones.push(h('button', { class: 'btn', onclick: reasignarLead }, 'Reasignar'));
  if (l.estado === 'cerrado' && puedoEditarCerrado()) acciones.push(h('button', { class: 'btn', onclick: intentar(async () => { await api('POST', `/leads/${l.id}/reabrir`); abrirLead(l.id); }) }, 'Reabrir'));
  acciones.push(h('button', { class: 'btn btn-info', onclick: () => $('#d-side').classList.toggle('open') }, 'ℹ Datos'));
  $('#d-head').replaceChildren(
    h('button', { class: 'btn btn-sm back', onclick: () => { location.hash = 'bandeja'; } }, '←'),
    h('div', { class: 'who' },
      h('strong', null, c.nombre || c.telefono_fmt),
      h('a', { href: `tel:+${c.wa_id}` }, `+${c.wa_id.slice(0, 2)} ${c.telefono_fmt}`),
      ' ', l.producto && h('span', { class: 'badge badge-blue' }, l.producto)),
    h('div', { class: 'chat-actions' }, acciones));
}
const puedoEditarCerrado = () => esAdmin() || S.det.lead.asignado_a === S.me.id;

function renderBanners() {
  const l = S.det.lead; const out = [];
  if (l.estado === 'pendiente') {
    out.push(h('div', { class: 'banner banner-crit' }, '⚡ Nadie la tomó todavía. Respondé o tocá ', h('b', null, 'Tomar'), ': el primero se la queda.'));
  } else if (l.estado === 'asignado' && l.asignado_a !== S.me.id) {
    out.push(h('div', { class: 'banner banner-blue' }, `👤 La atiende ${l.asignado_nombre}${l.motivo_asignacion ? ` (${l.motivo_asignacion})` : ''}.`));
  }
  if (l.estado === 'asignado' && !l.primera_respuesta_at && l.vence_at) {
    out.push(h('div', { class: 'banner banner-warn' }, '⏱ Tiempo para la primera respuesta: ', h('b', { dataset: { vence: l.vence_at, modo: 'banner' } }, reloj(l.vence_at - ahora())), '. Si nadie responde, vuelve a la bolsa.'));
  }
  if (l.estado !== 'cerrado' && !S.det.ventana_abierta) {
    out.push(h('div', { class: 'banner banner-warn' },
      'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo deja escribirle con una plantilla aprobada.',
      S.cfg.plantilla && puedoEditar() && h('button', { class: 'btn btn-sm', onclick: intentar(async () => { await api('POST', `/leads/${l.id}/plantilla`); toast('Plantilla enviada.'); abrirLead(l.id); }) }, 'Enviar plantilla de seguimiento')));
  }
  if (l.estado === 'cerrado') {
    out.push(h('div', { class: `banner ${l.resultado === 'vendido' ? 'banner-blue' : 'banner-warn'}` }, l.resultado === 'vendido' ? `🎉 Vendido — ${usd(l.monto_usd)}` : 'Consulta cerrada como perdida.', ' Si el cliente vuelve a escribir se abre una consulta nueva para su titular.'));
  }
  $('#d-banners').replaceChildren(...out.filter(Boolean));
}

function tick(m) {
  if (m.direccion !== 'out') return null;
  const map = { sent: ['✓', ''], delivered: ['✓✓', ''], read: ['✓✓', 'tick-read'], failed: ['⚠ no enviado', 'tick-fail'], simulado: ['demo', ''], celular: ['📱 celular', ''] };
  const [t, cls] = map[m.estado] || ['', ''];
  return h('span', { class: cls, title: m.error || m.estado || '' }, t);
}

// Las fotos/audios se bajan con la sesión (fetch + blob) y se cargan cuando llegan
function conMedia(el, id, attr = 'src') {
  window.backend.media(id).then((u) => { el[attr] = u; }).catch(() => { el.replaceWith(document.createTextNode('[archivo no disponible]')); });
  return el;
}
function contenidoMsg(m) {
  const id = m.media_id;
  if (m.tipo === 'image' && id) return [conMedia(h('img', { alt: 'Imagen' }), id), m.cuerpo && h('div', null, m.cuerpo)];
  if (m.tipo === 'video' && id) return [conMedia(h('video', { controls: true, preload: 'metadata' }), id), m.cuerpo && h('div', null, m.cuerpo)];
  if (m.tipo === 'audio' && id) return [conMedia(h('audio', { controls: true }), id)];
  if ((m.tipo === 'document' || m.tipo === 'sticker') && id) return [conMedia(h('a', { target: '_blank', rel: 'noopener' }, `📎 ${m.cuerpo || 'Archivo'}`), id, 'href')];
  return [m.cuerpo || ''];
}

function renderMensajes() {
  const box = $('#d-msgs');
  const pegado = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const items = []; let ultimoDia = null;
  for (const m of S.det.mensajes) {
    const dia = new Date(m.created_at).toDateString();
    if (dia !== ultimoDia) { items.push(h('div', { class: 'day-sep' }, diaLargo(m.created_at))); ultimoDia = dia; }
    const autor = m.direccion === 'nota' ? `📝 Nota de ${m.autor || '?'}` : m.direccion === 'out' ? (m.tipo === 'auto' ? 'Respuesta automática' : m.autor || (m.estado === 'celular' ? 'Desde el celular' : '')) : '';
    items.push(h('div', { class: `msg ${m.direccion}${m.tipo === 'auto' ? ' auto' : ''}` },
      contenidoMsg(m),
      h('div', { class: 'ft' }, autor && h('span', { class: 'au' }, autor), h('span', null, hora(m.created_at)), tick(m))));
  }
  box.replaceChildren(...items);
  if (pegado || !box.dataset.ok) { box.scrollTop = box.scrollHeight; box.dataset.ok = '1'; }
}

function renderComposer(nuevo) {
  const wrap = $('#d-composer');
  const habilitado = S.det.lead.estado !== 'cerrado' && puedoEscribir();
  if (!habilitado) { wrap.replaceChildren(); wrap.dataset.on = ''; return; }
  if (!nuevo && wrap.dataset.on) {
    const btn = $('#c-send');
    if (btn) btn.textContent = S.nota ? 'Guardar nota' : S.det.lead.estado === 'pendiente' ? 'Responder y tomar' : 'Enviar';
    return;
  }
  wrap.dataset.on = '1';
  const ta = h('textarea', { id: 'c-text', rows: 2, placeholder: matchMedia('(pointer: coarse)').matches ? 'Escribí tu respuesta…' : 'Escribí tu respuesta… (Enter envía, Shift+Enter salto de línea)', maxlength: 4096 });
  const enviar = intentar(async () => {
    const texto = ta.value.trim(); if (!texto) return;
    const btn = $('#c-send'); btn.disabled = true;
    try {
      if (S.nota) await api('POST', `/leads/${S.sel}/notas`, { texto });
      else await api('POST', `/leads/${S.sel}/mensajes`, { texto });
      ta.value = ''; autosize();
      await abrirLead(S.sel, { silencioso: true });
    } finally { btn.disabled = false; ta.focus(); }
  });
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); enviar(); } });
  const chk = h('input', { type: 'checkbox', onchange: (e) => { S.nota = e.target.checked; form.classList.toggle('is-nota', S.nota); renderComposer(false); } });
  const form = h('div', { class: 'composer' },
    ta,
    h('button', { class: 'btn btn-primary', id: 'c-send', onclick: enviar }, S.det.lead.estado === 'pendiente' ? 'Responder y tomar' : 'Enviar'),
    h('div', { class: 'composer-tools' },
      h('label', { class: 'check' }, chk, 'Nota interna (el cliente no la ve)')));
  wrap.replaceChildren(form);
}

function renderSide() {
  const d = S.det; const l = d.lead; const c = d.contacto;
  const editable = puedoEditar() && l.estado !== 'cerrado';
  const guardar = (campo) => intentar(async (e) => {
    let valor = e.target.value;
    if (campo === 'producto_id') {
      const cod = valor.split(' · ')[0].trim();
      const p = S.porCodigo.get(cod);
      if (valor && !p) { toast('Elegí un producto de la lista.', true); return; }
      valor = p ? p.id : null;
    }
    await api('PATCH', `/leads/${l.id}`, { [campo]: valor });
    toast('Guardado.');
  });
  const prod = l.producto_id ? S.catalogo.find((p) => p.id === l.producto_id) : null;
  const sel = (campo, opciones, actual) => h('select', { disabled: !editable, onchange: guardar(campo) },
    opciones.map((o) => h('option', { value: o, selected: o === actual }, o)));
  const origenes = S.cfg.origenesTodos.includes(l.origen) ? S.cfg.origenesTodos : [l.origen, ...S.cfg.origenesTodos];

  const etiquetas = {
    creado: (e) => { try { const j = JSON.parse(e.detalle); return `Entró por ${j.origen}${j.producto ? ` · ${j.producto}` : ''}${j.deteccion === 'nombre' ? ' (detectado por texto)' : ''}`; } catch { return 'Entró la consulta'; } },
    asignado: (e) => `Asignado a ${e.usuario} (${e.detalle})`,
    tomado: (e) => `${e.usuario} la tomó`,
    primera_respuesta: (e) => `${e.usuario} respondió (${minTxt(Number(e.detalle))})`,
    liberado_timeout: (e) => `⏰ ${e.detalle}: volvió a la bolsa`,
    liberado: (e) => `${e.usuario || 'Sistema'} la liberó${e.detalle ? ` — ${e.detalle}` : ''}`,
    alerta_gerencia: (e) => `🚨 Alerta a gerencia: ${e.detalle}`,
    reasignado: (e) => `${e.usuario} la reasignó ${e.detalle}`,
    etapa: (e) => `${e.usuario}: etapa «${e.detalle}»`,
    producto: (e) => `${e.usuario}: producto ${e.detalle}`,
    vendido: (e) => `🎉 ${e.usuario} cerró la venta (${e.detalle})`,
    perdido: (e) => `${e.usuario} la marcó como perdida`,
    reabierto: (e) => `${e.usuario} la reabrió`,
    respuesta_celular: () => 'Respondida desde la app del celular',
  };

  $('#d-side').replaceChildren(...[
    h('section', null,
      h('h4', null, 'Consulta'),
      h('label', null, 'Embarcación / producto', h('input', { list: 'dl-productos', value: prod ? `${prod.codigo} · ${prod.nombre}` : '', placeholder: 'Sin identificar — buscá', disabled: !editable, onchange: guardar('producto_id') })),
      h('label', null, 'Etapa', sel('etapa', S.cfg.etapas, l.etapa)),
      h('label', null, 'Origen', sel('origen', origenes, l.origen)),
      l.referral && h('p', { class: 'small muted' }, `Anuncio: ${l.referral.headline || l.referral.source_id || ''}`)),
    h('section', null,
      h('h4', null, 'Cliente'),
      h('label', null, 'Nombre', h('input', { value: c.nombre || '', disabled: !editable, onchange: guardar('nombre') })),
      h('label', null, 'Localidad', h('input', { value: c.localidad || '', disabled: !editable, onchange: guardar('localidad') })),
      h('label', null, 'Provincia', h('input', { value: c.provincia || '', disabled: !editable, onchange: guardar('provincia') })),
      h('dl', { class: 'kv' },
        h('dt', null, 'Titular'), h('dd', null, c.titular_nombre || '—'),
        h('dt', null, 'Cliente desde'), h('dd', null, fecha(c.created_at)),
        c.vendido ? [h('dt', null, 'Compró'), h('dd', null, 'Sí')] : null)),
    d.historial.length ? h('section', null,
      h('h4', null, `Consultas anteriores (${d.historial.length})`),
      h('ul', { class: 'timeline' }, d.historial.map((x) => h('li', null,
        h('time', null, fecha(x.created_at)),
        h('a', { href: `#lead/${x.id}` }, `${x.producto || 'Sin producto'} · ${x.vendedor || 'sin asignar'}`),
        x.resultado ? ` — ${x.resultado}${x.monto_usd ? ` ${usd(x.monto_usd)}` : ''}` : '')))) : null,
    h('section', null,
      h('h4', null, 'Historial'),
      h('ul', { class: 'timeline' }, d.eventos.map((e) => h('li', null,
        h('time', null, `${fecha(e.created_at)} ${hora(e.created_at)}`),
        (etiquetas[e.tipo] || ((x) => x.tipo))(e))))),
  ].filter(Boolean));
}

async function marcarVenta() {
  const fd = await dialogo({
    titulo: '🎉 Registrar venta',
    cuerpo: [h('label', null, 'Monto de la venta (USD)', h('input', { name: 'monto', type: 'number', min: 1, step: 1, required: true, inputmode: 'numeric' }))],
    ok: 'Registrar venta',
  });
  if (!fd) return;
  try { await api('POST', `/leads/${S.sel}/cerrar`, { resultado: 'vendido', monto: Number(fd.get('monto')) }); toast('¡Venta registrada!'); abrirLead(S.sel); }
  catch (e) { toast(e.message, true); }
}
async function marcarPerdido() {
  const fd = await dialogo({
    titulo: 'Marcar como perdida',
    cuerpo: [h('label', null, 'Motivo (queda como nota interna)', h('input', { name: 'motivo', placeholder: 'Ej: compró en otro lado, sin presupuesto…' }))],
    ok: 'Marcar perdida', peligro: true,
  });
  if (!fd) return;
  try {
    const motivo = String(fd.get('motivo') || '').trim();
    if (motivo) await api('POST', `/leads/${S.sel}/notas`, { texto: `Perdida: ${motivo}` });
    await api('POST', `/leads/${S.sel}/cerrar`, { resultado: 'perdido' });
    abrirLead(S.sel);
  } catch (e) { toast(e.message, true); }
}
async function liberarLead() {
  const fd = await dialogo({ titulo: '¿Devolver a la bolsa?', cuerpo: [h('p', { class: 'muted' }, 'La consulta vuelve a "Sin tomar" y les llega aviso a los demás vendedores.')], ok: 'Liberar', peligro: true });
  if (!fd) return;
  try { await api('POST', `/leads/${S.sel}/liberar`); toast('Liberada.'); location.hash = 'bandeja'; } catch (e) { toast(e.message, true); }
}
async function reasignarLead() {
  const fd = await dialogo({
    titulo: 'Reasignar consulta',
    cuerpo: [h('label', null, 'Asignar a', h('select', { name: 'user' }, S.cfg.usuarios.map((u) => h('option', { value: u.id, selected: u.id === S.det.lead.asignado_a }, `${u.nombre}${u.rol === 'admin' ? ' (gerencia)' : ''}`))))],
    ok: 'Reasignar',
  });
  if (!fd) return;
  try { await api('POST', `/leads/${S.sel}/reasignar`, { user_id: Number(fd.get('user')) }); toast('Reasignada.'); abrirLead(S.sel); } catch (e) { toast(e.message, true); }
}

// ---------- Métricas ----------
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function preset(p) {
  const hoy = new Date(); let desde = new Date(hoy); let hasta = new Date(hoy);
  if (p === '7d') desde.setDate(hoy.getDate() - 6);
  if (p === 'mes') desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  if (p === 'mesant') { desde = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1); hasta = new Date(hoy.getFullYear(), hoy.getMonth(), 0); }
  $('#m-desde').value = isoLocal(desde); $('#m-hasta').value = isoLocal(hasta);
  for (const b of $$('#presets button')) b.classList.toggle('active', b.dataset.p === p);
  cargarMetricas();
}
let metricasListas = false;
function iniciarMetricas() {
  if (!metricasListas) {
    metricasListas = true;
    $$('#presets button').forEach((b) => b.addEventListener('click', () => preset(b.dataset.p)));
    for (const id of ['#m-desde', '#m-hasta']) $(id).addEventListener('change', () => { $$('#presets button').forEach((b) => b.classList.remove('active')); cargarMetricas(); });
    preset('mes');
  } else cargarMetricas();
}

const cargarMetricas = intentar(async () => {
  const qs = `desde=${$('#m-desde').value}&hasta=${$('#m-hasta').value}`;
  $('#m-export').onclick = intentar(async (e) => { e.preventDefault(); await window.backend.exportarCSV($('#m-desde').value, $('#m-hasta').value); });
  const m = await api('GET', `/metricas?${qs}`);
  const t = m.totales;
  const kpi = (lbl, val, sub) => h('div', { class: 'kpi' }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'val' }, val), sub && h('div', { class: 'sub' }, sub));
  $('#m-body').replaceChildren(
    h('div', { class: 'kpis' },
      kpi('Consultas', t.leads, `${t.sin_atender_ahora} sin tomar ahora`),
      kpi('Atendidas', t.atendidos, t.leads ? `${pct(t.atendidos / t.leads)} del total` : null),
      kpi('1ª respuesta (mediana)', minTxt(t.respuesta_mediana_min), `promedio ${minTxt(t.respuesta_promedio_min)}`),
      kpi('Ventas', t.vendidos, usd(t.monto_usd)),
      kpi('Conversión', pct(t.conversion), `${t.perdidos} perdidas`),
      kpi('Sin respuesta a tiempo', t.timeouts, `${t.alertas_gerencia} alerta${t.alertas_gerencia === 1 ? '' : 's'} a gerencia`)),
    h('div', { class: 'card' },
      h('h3', null, 'Por vendedor'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Vendedor', 'Consultas', 'Respondió', '1ª resp. (mediana)', 'Se le vencieron', 'Abiertas', 'Ventas', 'Monto', 'Conversión'].map((x) => h('th', null, x)))),
        h('tbody', null, m.porVendedor.map((v) => h('tr', null,
          h('td', null, v.nombre), h('td', null, v.leads), h('td', null, v.respondidos), h('td', null, minTxt(v.respuesta_mediana_min)),
          h('td', null, v.timeouts), h('td', null, v.abiertos), h('td', null, v.vendidos), h('td', null, usd(v.monto_usd)), h('td', null, pct(v.conversion)))))))),
    h('div', { class: 'card' }, h('h3', null, 'Consultas por día'), columnas(m.porDia)),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h3', null, 'Por origen'), barras(m.porOrigen)),
      h('div', { class: 'card' }, h('h3', null, 'Embarcaciones más consultadas'), barras(m.porProducto))),
  );
});

const tip = $('#tooltip');
function mostrarTip(e, texto) { tip.textContent = texto; tip.hidden = false; tip.style.left = `${Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8)}px`; tip.style.top = `${e.clientY - 34}px`; }
const ocultarTip = () => { tip.hidden = true; };

function barras(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Sin datos en este período.');
  const max = Math.max(...rows.map((r) => r.leads), 1);
  return h('div', null,
    h('div', { class: 'hbars' }, rows.map((r) => h('div', {
      class: 'hbar',
      onmousemove: (e) => mostrarTip(e, `${r.nombre}: ${r.leads} consultas · ${r.vendidos} ventas${r.monto_usd ? ` · ${usd(r.monto_usd)}` : ''}`),
      onmouseleave: ocultarTip,
    },
    h('span', { class: 'nm', title: r.nombre }, r.nombre),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${(r.leads / max) * 100}%` })),
    h('span', { class: 'v' }, r.leads)))),
    tablaDatos(['Nombre', 'Consultas', 'Ventas', 'Monto'], rows.map((r) => [r.nombre, r.leads, r.vendidos, usd(r.monto_usd)])));
}

function tablaDatos(head, rows) {
  return h('details', { class: 'tabla-datos' }, h('summary', null, 'Ver como tabla'),
    h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((x) => h('td', null, x)))))));
}

function columnas(dias) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  const W = Math.max(320, ($('#m-body').clientWidth || 900) - 34); const H = 190; const top = 10; const bottom = 24; const left = 28;
  const max = Math.max(...dias.map((d) => d.leads), 1);
  const paso = Math.max(1, Math.ceil(max / 4));
  const ymax = paso * Math.ceil(max / paso);
  const ancho = (W - left) / Math.max(dias.length, 1);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Consultas por día' });
  for (let v = 0; v <= ymax; v += paso) {
    const y = top + (H - top - bottom) * (1 - v / ymax);
    svg.append(s('line', { x1: left, x2: W, y1: y, y2: y, class: 'axis', 'stroke-width': v === 0 ? 1 : 0.5 }));
    const tx = s('text', { x: left - 6, y: y + 4, 'text-anchor': 'end' }); tx.textContent = v; svg.append(tx);
  }
  const cada = Math.ceil(dias.length / 10);
  dias.forEach((d, i) => {
    const x = left + i * ancho;
    const alto = (H - top - bottom) * (d.leads / ymax);
    const g = s('g', {});
    // barra fina centrada, extremo de datos redondeado (4px) y anclada a la base
    const bw = Math.max(2, Math.min(ancho * 0.6, 28));
    const bx = x + (ancho - bw) / 2; const by = H - bottom - alto; const r = Math.min(4, bw / 2, alto);
    const bar = s('path', { class: 'bar', d: d.leads ? `M${bx},${H - bottom}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + bw - r}Q${bx + bw},${by} ${bx + bw},${by + r}V${H - bottom}Z` : '' });
    const hit = s('rect', { x, y: top, width: ancho, height: H - top - bottom, class: 'hit' });
    const [yy, mm, dd] = d.fecha.split('-');
    hit.addEventListener('mousemove', (e) => mostrarTip(e, `${dd}/${mm}: ${d.leads} consulta${d.leads === 1 ? '' : 's'}`));
    hit.addEventListener('mouseleave', ocultarTip);
    g.append(bar, hit); svg.append(g);
    if (i % cada === 0) { const tx = s('text', { x: x + ancho / 2, y: H - 6, 'text-anchor': 'middle' }); tx.textContent = `${dd}/${mm}`; svg.append(tx); }
    void yy;
  });
  return h('div', { class: 'cols' }, svg, tablaDatos(['Día', 'Consultas'], dias.map((d) => [d.fecha.split('-').reverse().join('/'), d.leads])));
}

// ---------- Links ----------
let linksListos = false;
function iniciarLinks() {
  if (linksListos) return;
  linksListos = true;
  $('#l-numero').value = S.cfg.waNumber || '';
  $('#l-origen').replaceChildren(h('option', { value: '' }, '— Sin especificar —'), ...S.cfg.origenes.map((o) => h('option', { value: o.codigo }, o.nombre)));
  $('#f-link').addEventListener('submit', intentar(async (e) => {
    e.preventDefault();
    const val = $('#l-prod').value.trim();
    const cod = val ? val.split(' · ')[0].trim() : '';
    if (val && !S.porCodigo.has(cod)) { toast('Elegí un producto de la lista (o dejalo vacío).', true); return; }
    const r = await api('GET', `/links?numero=${encodeURIComponent($('#l-numero').value)}&codigo=${encodeURIComponent(cod)}&origen=${encodeURIComponent($('#l-origen').value)}`);
    const qr = h('div', { class: 'qr' });
    // SVG generado por nuestro servidor (librería qrcode) a partir de la URL
    qr.innerHTML = r.qr;
    const descargar = () => {
      const blob = new Blob([r.qr], { type: 'image/svg+xml' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `qr-${cod || 'consulta'}-${$('#l-origen').value || 'general'}.svg` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('#l-result').replaceChildren(h('div', { class: 'card link-out' },
      h('div', { class: 'row', style: 'display:grid;gap:.6rem' },
        h('div', null, h('b', null, 'Mensaje que le aparece escrito al cliente:'), h('p', null, r.texto)),
        h('code', null, r.url),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => { await navigator.clipboard.writeText(r.url); toast('Link copiado.'); } }, 'Copiar link'),
          h('a', { class: 'btn', href: r.url, target: '_blank', rel: 'noopener' }, 'Probar'),
          h('button', { class: 'btn', type: 'button', onclick: descargar }, 'Descargar QR')),
        h('p', { class: 'small muted' }, 'El código "(ref …)" al final es lo que le permite al sistema saber la embarcación y el origen. Si el cliente lo borra, igual intenta reconocer la embarcación por el nombre.')),
      qr));
  }));
}

// ---------- Configuración ----------
const DIAS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const cargarConfig = intentar(async () => {
  const [{ settings: st, demo, webhook }, { usuarios }] = await Promise.all([api('GET', '/admin/config'), api('GET', '/admin/usuarios')]);
  const vendedores = usuarios.filter((u) => u.activo);
  const guardar = (payload) => intentar(async () => { await api('PUT', '/admin/config', payload()); toast('Configuración guardada.'); cargarConfig(); });

  // Reglas
  const fMin = h('input', { type: 'number', min: 1, max: 240, value: st.minutos_respuesta });
  const fDias = h('input', { type: 'number', min: 1, max: 365, value: st.dias_titular });
  const fHorAct = h('input', { type: 'checkbox', checked: st.horario.activo });
  const fDesde = h('input', { type: 'time', value: st.horario.desde });
  const fHasta = h('input', { type: 'time', value: st.horario.hasta });
  const fDiasChk = DIAS.map((d, i) => h('input', { type: 'checkbox', value: i, checked: st.horario.dias.includes(i) }));

  // Zonas
  const fZonAct = h('input', { type: 'checkbox', checked: st.zonas.activo });
  const zonasBox = h('div', { style: 'display:grid;gap:.5rem' });
  const filaZona = (z = { nombre: '', prefijos: [], titular: '' }) => {
    const row = h('div', { class: 'zona-row' },
      h('label', null, 'Zona', h('input', { class: 'z-nom', value: z.nombre })),
      h('label', null, 'Prefijos (sin 0 ni 15)', h('input', { class: 'z-pre', value: (z.prefijos || []).join(', '), placeholder: '376, 3755' })),
      h('label', null, 'Titular', h('select', { class: 'z-tit' }, h('option', { value: '' }, '—'), vendedores.map((u) => h('option', { value: u.nombre, selected: u.nombre === z.titular }, u.nombre)))),
      h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => row.remove() }, 'Quitar'));
    zonasBox.append(row);
  };
  st.zonas.lista.forEach(filaZona);

  // Mensajes
  const fBienAct = h('input', { type: 'checkbox', checked: st.bienvenida.activo });
  const fBienTxt = h('textarea', { rows: 2 }, st.bienvenida.texto);
  const fPlNom = h('input', { value: st.plantilla.nombre, placeholder: 'seguimiento_consulta' });
  const fPlIdi = h('input', { value: st.plantilla.idioma });
  const fPlNomb = h('input', { type: 'checkbox', checked: st.plantilla.usa_nombre });
  const fPlTxt = h('input', { value: st.plantilla.texto, placeholder: 'Texto de referencia para el historial' });

  const secciones = [
    h('div', { class: `card ${demo ? 'banner-warn' : ''}` },
      h('h3', null, demo ? '⚠ Modo demo: WhatsApp no está conectado' : '✅ WhatsApp conectado'),
      h('p', { class: 'small' }, demo
        ? 'Los mensajes salientes se guardan pero no se envían. Cargá WA_TOKEN y WA_PHONE_NUMBER_ID en el servidor para conectar. Mientras tanto podés probar con el simulador de abajo.'
        : 'Los mensajes se envían por la API oficial de WhatsApp.'),
      h('p', { class: 'small' }, 'URL del webhook para Meta: ', h('code', null, webhook))),

    h('div', { class: 'card' }, h('h3', null, 'Reglas de asignación'),
      h('div', { class: 'form-grid' },
        h('label', null, 'Minutos para la primera respuesta', fMin),
        h('label', null, 'Días que el cliente queda con su vendedor sin actividad', fDias),
        h('label', { class: 'check full' }, fHorAct, 'El reloj solo corre en horario de atención'),
        h('label', null, 'Desde', fDesde), h('label', null, 'Hasta', fHasta),
        h('div', { class: 'dias full' }, fDiasChk.map((c, i) => h('label', { class: 'check' }, c, DIAS[i]))),
        h('div', { class: 'full' }, h('button', { class: 'btn btn-primary', onclick: guardar(() => ({
          minutos_respuesta: Number(fMin.value), dias_titular: Number(fDias.value),
          horario: { activo: fHorAct.checked, desde: fDesde.value, hasta: fHasta.value, dias: fDiasChk.filter((c) => c.checked).map((c) => Number(c.value)) },
        })) }, 'Guardar reglas')))),

    h('div', { class: 'card' }, h('h3', null, 'Zonas por código de área'),
      h('p', { class: 'small muted' }, 'Si el número del cliente empieza con alguno de estos prefijos, la consulta va directo al titular de la zona (con el mismo reloj: si no responde, vuelve a la bolsa). Desactivalo si quieren que todo sea "el primero que contesta".'),
      h('label', { class: 'check' }, fZonAct, 'Usar zonas'),
      zonasBox,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => filaZona() }, '+ Agregar zona'),
        h('button', { class: 'btn btn-primary', onclick: guardar(() => ({
          zonas: { activo: fZonAct.checked, lista: $$('.zona-row', zonasBox).map((r) => ({ nombre: $('.z-nom', r).value, prefijos: $('.z-pre', r).value, titular: $('.z-tit', r).value })) },
        })) }, 'Guardar zonas'))),

    h('div', { class: 'card' }, h('h3', null, 'Mensajes automáticos'),
      h('div', { class: 'form-grid' },
        h('label', { class: 'check full' }, fBienAct, 'Responder automáticamente cuando entra una consulta nueva'),
        h('label', { class: 'full' }, 'Texto de bienvenida', fBienTxt),
        h('p', { class: 'small muted full' }, 'La respuesta automática no cuenta como "atendida": el reloj de los vendedores sigue corriendo.'),
        h('label', null, 'Plantilla de seguimiento (nombre en Meta)', fPlNom),
        h('label', null, 'Idioma', fPlIdi),
        h('label', { class: 'check' }, fPlNomb, 'La plantilla usa {{1}} = nombre del cliente'),
        h('label', null, 'Texto (solo para el historial)', fPlTxt),
        h('div', { class: 'full' }, h('button', { class: 'btn btn-primary', onclick: guardar(() => ({
          bienvenida: { activo: fBienAct.checked, texto: fBienTxt.value },
          plantilla: { nombre: fPlNom.value, idioma: fPlIdi.value, usa_nombre: fPlNomb.checked, texto: fPlTxt.value },
        })) }, 'Guardar mensajes')))),

    h('div', { class: 'card' }, h('h3', null, 'Usuarios'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Nombre', 'Usuario', 'Rol', 'Recibe consultas', 'Activo', ''].map((x) => h('th', null, x)))),
        h('tbody', null, usuarios.map((u) => {
          const patch = (campo) => intentar(async (e) => { await api('PATCH', `/admin/usuarios/${u.id}`, { [campo]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }); toast('Guardado.'); cargarConfig(); });
          return h('tr', null,
            h('td', null, u.nombre), h('td', null, u.usuario),
            h('td', null, h('select', { onchange: patch('rol') }, h('option', { value: 'vendedor', selected: u.rol === 'vendedor' }, 'Vendedor'), h('option', { value: 'admin', selected: u.rol === 'admin' }, 'Gerencia/Admin'))),
            h('td', null, h('input', { type: 'checkbox', checked: u.recibe_leads, onchange: patch('recibe_leads') })),
            h('td', null, h('input', { type: 'checkbox', checked: u.activo, onchange: patch('activo') })),
            h('td', null, h('button', { class: 'btn btn-sm', onclick: intentar(async () => {
              const ok = await dialogo({ titulo: `¿Resetear la clave de ${u.nombre}?`, cuerpo: [h('p', { class: 'muted' }, 'Se genera una clave temporal y tendrá que cambiarla al ingresar.')], ok: 'Resetear' });
              if (!ok) return;
              const { clave } = await api('POST', `/admin/usuarios/${u.id}/reset-clave`);
              await dialogo({ titulo: `Clave temporal de ${u.nombre}`, cuerpo: [h('p', { class: 'secret' }, clave), h('p', { class: 'small muted' }, 'Pasásela por un canal privado. No se vuelve a mostrar.')], ok: 'Listo', cancelar: null });
            }) }, 'Resetear clave')));
        })))),
      h('form', { class: 'row', style: 'margin-top:.8rem', onsubmit: intentar(async (e) => {
        e.preventDefault(); const fd = new FormData(e.target);
        const { clave } = await api('POST', '/admin/usuarios', { nombre: fd.get('nombre'), usuario: fd.get('usuario'), rol: fd.get('rol') });
        await dialogo({ titulo: `Usuario ${fd.get('usuario')} creado`, cuerpo: [h('p', null, 'Clave inicial:'), h('p', { class: 'secret' }, clave), h('p', { class: 'small muted' }, 'La tiene que cambiar al primer ingreso.')], ok: 'Listo', cancelar: null });
        cargarConfig();
      }) },
      h('input', { name: 'nombre', placeholder: 'Nombre', required: true, style: 'max-width:180px' }),
      h('input', { name: 'usuario', placeholder: 'usuario', required: true, pattern: '[a-z0-9._\\-]{3,30}', style: 'max-width:160px' }),
      h('select', { name: 'rol', style: 'max-width:170px' }, h('option', { value: 'vendedor' }, 'Vendedor'), h('option', { value: 'admin' }, 'Gerencia/Admin')),
      h('button', { class: 'btn' }, '+ Agregar usuario'))),
  ];

  if (S.cfg.demoMode) {
    secciones.unshift(h('div', { class: 'card' }, h('h3', null, 'Demostración'),
      h('p', { class: 'small muted' }, 'Vuelve todo a los datos de ejemplo iniciales. Borra lo que se haya probado.'),
      h('button', { class: 'btn btn-danger', onclick: intentar(async () => {
        const ok = await dialogo({ titulo: '¿Reiniciar la demostración?', cuerpo: [h('p', { class: 'muted' }, 'Se borran todas las consultas y se cargan de nuevo los datos de ejemplo.')], ok: 'Reiniciar', peligro: true });
        if (!ok) return;
        await api('POST', '/admin/demo/reset');
        toast('Demostración reiniciada.');
        cargarConfig();
      }) }, 'Reiniciar demostración')));
  }

  if (S.cfg.simulador) {
    const fTel = h('input', { name: 'telefono', placeholder: '376 4123456', required: true, inputmode: 'tel' });
    const fNom = h('input', { name: 'nombre', placeholder: 'Nombre que figura en WhatsApp' });
    const fProd = h('input', { list: 'dl-productos', placeholder: 'Opcional: simular link de un producto' });
    const fOri = h('select', null, h('option', { value: '' }, '— origen —'), S.cfg.origenes.map((o) => h('option', { value: o.codigo }, o.nombre)));
    const fTxt = h('textarea', { name: 'texto', rows: 2, required: true, placeholder: 'Hola! Quiero información…' });
    const armar = () => {
      const p = S.porCodigo.get(fProd.value.split(' · ')[0].trim());
      if (p) fTxt.value = `Hola! Quiero información sobre: ${p.nombre} (ref ${p.codigo}${fOri.value ? '-' + fOri.value : ''})`;
    };
    fProd.addEventListener('change', armar); fOri.addEventListener('change', armar);
    secciones.push(h('div', { class: 'card' }, h('h3', null, '🧪 Simulador de consultas'),
      h('p', { class: 'small muted' }, 'Hace de cuenta que un cliente escribe al WhatsApp de la empresa. Probá con 376… (Posadas), 362… (Resistencia) o 351… (Córdoba, zona neutral).'),
      h('form', { class: 'form-grid', onsubmit: intentar(async (e) => {
        e.preventDefault();
        const { lead_id: id } = await api('POST', '/admin/simular', { telefono: fTel.value, nombre: fNom.value, texto: fTxt.value });
        toast(`Consulta simulada (#${id}).`);
      }) },
      h('label', null, 'Teléfono del cliente', fTel), h('label', null, 'Nombre', fNom),
      h('label', null, 'Producto', fProd), h('label', null, 'Origen', fOri),
      h('label', { class: 'full' }, 'Mensaje', fTxt),
      h('div', { class: 'full' }, h('button', { class: 'btn btn-primary' }, 'Simular mensaje entrante')))));
  }
  $('#cfg-body').replaceChildren(...secciones);
});

// ---------- Notificaciones push ----------
function b64ToUint8(b64) {
  const pad64 = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad64).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function prepararPush() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register('/sw.js').catch(() => null);
  if (!reg || !('PushManager' in window) || !('Notification' in window)) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') { api('POST', '/push/subscribe', { sub: sub.toJSON() }).catch(() => {}); return; }
  const btn = $('#btn-push');
  btn.hidden = Notification.permission === 'denied';
  btn.onclick = intentar(async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Sin permiso no podemos avisarte de consultas nuevas.', true); return; }
    const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(S.cfg.vapidKey) });
    await api('POST', '/push/subscribe', { sub: s.toJSON() });
    btn.hidden = true;
    toast('Listo: te vamos a avisar aunque tengas la app cerrada.');
  });
}

// ---------- Arranque ----------
iniciar();
