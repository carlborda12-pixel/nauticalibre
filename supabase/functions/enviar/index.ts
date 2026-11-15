// Envío de mensajes desde el panel. Valida la sesión, aplica las reglas en SQL y envía por la API de Meta.
import { admin, usuario, rpc, ErrorNegocio } from '../_shared/supabase.ts';
import { cors, json, error } from '../_shared/cors.ts';
import { wa, enviarTexto, enviarPlantilla, marcarLeido, ErrorWhatsApp, ERROR_VENTANA } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return error('Método no permitido', 405);
  const sb = admin();
  const yo = await usuario(req, sb);
  if (!yo) return error('Sesión vencida. Volvé a ingresar.', 401);

  let b: { accion?: string; lead_id?: number; texto?: string };
  try { b = await req.json(); } catch { return error('Solicitud inválida'); }

  try {
    switch (b.accion) {
      case 'estado':
        return json({ conectado: wa.conectado, simulador: !wa.conectado || Deno.env.get('ALLOW_SIMULATOR') === '1' });

      case 'texto': {
        const texto = String(b.texto || '').trim();
        if (!texto) return error('El mensaje está vacío.');
        if (texto.length > 4096) return error('Máximo 4096 caracteres.');
        const lead = Number(b.lead_id);
        // deno-lint-ignore no-explicit-any
        const prep = await rpc<any>(sb, 'preparar_envio', { p_lead: lead, p_user: yo.id, p_plantilla: false });
        const r = await enviarTexto(prep.wa_id, texto);
        await rpc(sb, 'registrar_salida', { p_lead: lead, p_user: yo.id, p_texto: texto, p_wa_msg_id: r.id, p_estado: r.simulado ? 'simulado' : 'sent', p_tipo: 'text' });
        return json({ ok: true });
      }

      case 'plantilla': {
        const lead = Number(b.lead_id);
        // deno-lint-ignore no-explicit-any
        const prep = await rpc<any>(sb, 'preparar_envio', { p_lead: lead, p_user: yo.id, p_plantilla: true });
        const p = prep.plantilla || {};
        if (!p.nombre) return error('No hay una plantilla configurada (Configuración → Mensajes automáticos).', 422);
        const vars = p.usa_nombre ? [prep.nombre || 'cliente'] : [];
        const r = await enviarPlantilla(prep.wa_id, p.nombre, p.idioma || 'es_AR', vars);
        await rpc(sb, 'registrar_salida', { p_lead: lead, p_user: yo.id, p_texto: `[Plantilla: ${p.nombre}]${p.texto ? ' ' + p.texto : ''}`, p_wa_msg_id: r.id, p_estado: r.simulado ? 'simulado' : 'sent', p_tipo: 'template' });
        return json({ ok: true });
      }

      case 'leido': {
        const ult = await rpc<string | null>(sb, 'marcar_visto', { p_lead: Number(b.lead_id), p_user: yo.id });
        if (ult) await marcarLeido(ult);
        return json({ ok: true });
      }

      default: return error('Acción desconocida.');
    }
  } catch (e) {
    if (e instanceof ErrorNegocio) return error(e.message, 422);
    if (e instanceof ErrorWhatsApp) {
      return error(e.code === ERROR_VENTANA ? 'WhatsApp rechazó el mensaje: la ventana de 24 h está cerrada.' : `WhatsApp no aceptó el mensaje: ${e.message}`, 502);
    }
    console.error('[enviar]', e);
    return error('Error interno. Probá de nuevo.', 500);
  }
});
