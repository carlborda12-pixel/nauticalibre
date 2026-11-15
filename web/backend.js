'use strict';
/* Capa de datos del panel sobre Supabase (Auth + RPC + Edge Functions + Realtime).
   Mantiene la misma interfaz api(método, ruta, cuerpo) que usa app.js. ApexTech */
(function () {
  const CFG = window.NAUTICA_CONFIG || {};
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    document.addEventListener('DOMContentLoaded', () => {
      document.body.innerHTML = '<p style="font-family:sans-serif;padding:2rem">Falta configurar <code>config.js</code> (URL y clave pública de Supabase).</p>';
    });
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'nautica-sesion' },
  });
  const DOMINIO = CFG.dominioUsuarios || 'nautica.local';
  let estadoWA = null;

  class SesionVencida extends Error { constructor() { super('Sesión vencida'); } }

  async function sesion() {
    const { data } = await sb.auth.getSession();
    if (!data.session) throw new SesionVencida();
    return data.session;
  }

  async function rpc(fn, args) {
    await sesion();
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) {
      if (/JWT|jwt|Sesión vencida/.test(error.message)) throw new SesionVencida();
      throw new Error(error.message);
    }
    return data;
  }

  async function fn(nombre, body) {
    const s = await sesion();
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/${nombre}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: CFG.supabaseAnonKey },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) throw new SesionVencida();
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }

  async function estado() {
    if (!estadoWA) estadoWA = await fn('enviar', { accion: 'estado' }).catch(() => ({ conectado: false, simulador: false }));
    return estadoWA;
  }

  function textoPrellenado(producto, origen) {
    const base = producto ? `Hola! Quiero información sobre: ${producto.nombre}` : 'Hola! Quiero hacer una consulta';
    const ref = producto ? `${producto.codigo}${origen ? '-' + origen : ''}` : (origen ? `X-${origen}` : '');
    return ref ? `${base} (ref ${ref})` : base;
  }

  // Rutas que usa app.js -> Supabase
  async function api(method, ruta, body) {
    const url = new URL(ruta, 'http://x');
    const p = url.pathname;
    const qs = url.searchParams;
    let m;

    if (method === 'POST' && p === '/login') {
      const usuario = String(body.usuario || '').trim().toLowerCase();
      const { error } = await sb.auth.signInWithPassword({ email: `${usuario}@${DOMINIO}`, password: String(body.clave || '') });
      if (error) throw new Error(/Invalid login/i.test(error.message) ? 'Usuario o clave incorrectos.' : /rate|too many/i.test(error.message) ? 'Demasiados intentos. Esperá unos minutos.' : error.message);
      return { ok: true };
    }
    if (method === 'POST' && p === '/logout') { await sb.auth.signOut(); return { ok: true }; }
    if (method === 'GET' && p === '/demo-info') return { demo: false };

    if (method === 'GET' && p === '/me') {
      const s = await sesion();
      const [cfg, est] = await Promise.all([rpc('mi_config'), estado()]);
      return {
        ...cfg,
        user: { ...cfg.user, debe_cambiar_pass: !!s.user.user_metadata?.debe_cambiar_pass },
        demo: !est.conectado, simulador: !!est.simulador, demoMode: false,
        waNumber: CFG.waNumber || null, vapidKey: CFG.vapidPublicKey || null,
      };
    }
    if (method === 'POST' && p === '/me/clave') {
      const s = await sesion();
      if (String(body.nueva || '').length < 8) throw new Error('La clave nueva debe tener al menos 8 caracteres.');
      const { error: e1 } = await sb.auth.signInWithPassword({ email: s.user.email, password: String(body.actual || '') });
      if (e1) throw new Error('La clave actual no es correcta.');
      const { error: e2 } = await sb.auth.updateUser({ password: body.nueva, data: { debe_cambiar_pass: false } });
      if (e2) throw new Error(e2.message);
      return { ok: true };
    }
    if (method === 'POST' && p === '/push/subscribe') return rpc('guardar_suscripcion', { p_sub: body.sub });

    if (method === 'GET' && p === '/leads') return rpc('listar_leads', { p_vista: qs.get('vista') || 'pool', p_q: qs.get('q') || '' });
    if ((m = p.match(/^\/leads\/(\d+)$/))) {
      const id = Number(m[1]);
      if (method === 'GET') {
        const d = await rpc('ver_lead', { p_lead: id });
        if (d.marcar_leido) fn('enviar', { accion: 'leido', lead_id: id }).catch(() => {});
        return d;
      }
      if (method === 'PATCH') return rpc('actualizar_lead', { p_lead: id, p: body });
    }
    if ((m = p.match(/^\/leads\/(\d+)\/(\w+)$/))) {
      const id = Number(m[1]);
      switch (m[2]) {
        case 'tomar': return rpc('tomar_lead', { p_lead: id });
        case 'liberar': return rpc('liberar_lead', { p_lead: id });
        case 'reasignar': return rpc('reasignar_lead', { p_lead: id, p_user: body.user_id });
        case 'notas': return rpc('agregar_nota', { p_lead: id, p_texto: body.texto });
        case 'cerrar': return rpc('cerrar_lead', { p_lead: id, p_resultado: body.resultado, p_monto: body.monto ?? null });
        case 'reabrir': return rpc('reabrir_lead', { p_lead: id });
        case 'mensajes': return fn('enviar', { accion: 'texto', lead_id: id, texto: body.texto });
        case 'plantilla': return fn('enviar', { accion: 'plantilla', lead_id: id });
      }
    }

    if (method === 'GET' && p === '/catalogo') {
      await sesion();
      const { data, error } = await sb.from('catalogo').select('id,codigo,nombre,categoria').order('categoria').order('id');
      if (error) throw new Error(error.message);
      return { productos: data };
    }
    if (method === 'GET' && p === '/links') {
      const numero = String(qs.get('numero') || CFG.waNumber || '').replace(/\D/g, '');
      if (!numero) throw new Error('Ingresá el número de WhatsApp de la empresa (con 549 adelante).');
      const { data: prod } = qs.get('codigo') ? await sb.from('catalogo').select('codigo,nombre').eq('codigo', qs.get('codigo')).maybeSingle() : { data: null };
      const texto = textoPrellenado(prod, qs.get('origen') || '');
      const link = `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
      const q = window.qrcode(0, 'M'); q.addData(link); q.make();
      return { url: link, texto, qr: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) };
    }

    if (method === 'GET' && p === '/metricas') return rpc('metricas', { p_desde: qs.get('desde') || null, p_hasta: qs.get('hasta') || null });

    if (method === 'GET' && p === '/admin/usuarios') return { usuarios: await rpc('admin_usuarios') };
    if (method === 'POST' && p === '/admin/usuarios') return fn('admin-usuarios', { accion: 'crear', ...body });
    if ((m = p.match(/^\/admin\/usuarios\/([0-9a-f-]+)$/)) && method === 'PATCH') return rpc('admin_actualizar_usuario', { p_id: m[1], p: body });
    if ((m = p.match(/^\/admin\/usuarios\/([0-9a-f-]+)\/reset-clave$/))) return fn('admin-usuarios', { accion: 'reset', id: m[1] });
    if (method === 'GET' && p === '/admin/config') {
      const [settings, est] = await Promise.all([rpc('admin_ajustes'), estado()]);
      return { settings, demo: !est.conectado, webhook: `${CFG.supabaseUrl}/functions/v1/whatsapp-webhook` };
    }
    if (method === 'PUT' && p === '/admin/config') return rpc('guardar_ajustes', { p: body });
    if (method === 'POST' && p === '/admin/simular') return fn('simular', body);

    throw new Error(`Ruta no soportada: ${method} ${p}`);
  }

  // Tiempo real: avisa cuando cambian consultas o mensajes que el usuario puede ver (respeta RLS)
  let canal = null;
  async function realtime(onCambio) {
    if (canal) await sb.removeChannel(canal);
    const s = await sesion();
    sb.realtime.setAuth(s.access_token);
    canal = sb.channel('nautica-cambios')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (e) => onCambio(e.new?.id || e.old?.id || 0))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes' }, (e) => onCambio(e.new?.lead_id || 0))
      .subscribe();
  }
  async function cerrarRealtime() { if (canal) { await sb.removeChannel(canal); canal = null; } }

  // Multimedia con el token de sesión (las etiquetas <img> no pueden mandar encabezados)
  const cacheMedia = new Map();
  async function media(id) {
    if (cacheMedia.has(id)) return cacheMedia.get(id);
    const s = await sesion();
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/media?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${s.access_token}`, apikey: CFG.supabaseAnonKey },
    });
    if (!r.ok) throw new Error('No disponible');
    const u = URL.createObjectURL(await r.blob());
    cacheMedia.set(id, u);
    return u;
  }

  async function exportarCSV(desde, hasta) {
    const filas = await rpc('exportar_leads', { p_desde: desde || null, p_hasta: hasta || null });
    const head = ['ID', 'Alta', 'Hora', 'Vendedor', 'Nombre', 'Teléfono', 'Localidad', 'Provincia', 'Categoría', 'Producto',
      'Origen', 'Etapa', 'Estado', 'Respondió', 'Min. a 1ª respuesta', 'Resultado', 'Monto USD', 'Cierre'];
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;  // evita inyección de fórmulas en Excel
      return /[";\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = '﻿' + [head, ...filas.map((f) => f.map((x, i) => (i === 16 && x != null ? String(x).replace('.', ',') : x)))]
      .map((f) => f.map(esc).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `leads-nautica-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') window.dispatchEvent(new Event('nautica:salio')); });

  window.backend = { api, realtime, cerrarRealtime, media, exportarCSV, SesionVencida };
})();
