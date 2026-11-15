// Simulador de consultas para probar antes de conectar WhatsApp (solo gerencia/administración).
import { admin, usuario, ErrorNegocio } from '../_shared/supabase.ts';
import { cors, json, error } from '../_shared/cors.ts';
import { wa } from '../_shared/whatsapp.ts';
import { procesarEntrante } from '../_shared/entrante.ts';

function aWaId(input: string) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return '549' + d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 12) for (const len of [2, 3, 4]) { if (d.slice(len, len + 2) === '15') { d = d.slice(0, len) + d.slice(len + 2); break; } }
  return '549' + d;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = admin();
  const yo = await usuario(req, sb);
  if (!yo) return error('Sesión vencida.', 401);
  if (yo.rol !== 'admin') return error('Solo gerencia/administración.', 403);
  if (wa.conectado && Deno.env.get('ALLOW_SIMULATOR') !== '1') return error('El simulador está desactivado: WhatsApp ya está conectado.', 403);
  const b = await req.json().catch(() => ({}));
  const waId = aWaId(b.telefono);
  if (!/^549\d{10}$/.test(waId)) return error('Teléfono inválido. Usá código de área, ej. 376 4123456.');
  const texto = String(b.texto || '').trim().slice(0, 1000);
  if (!texto) return error('Escribí el mensaje del cliente.');
  try {
    const r = await procesarEntrante(sb, { waId, nombre: String(b.nombre || '').trim().slice(0, 60) || null,
      msg: { id: `sim-${crypto.randomUUID()}`, type: 'text', text: { body: texto }, timestamp: String(Math.floor(Date.now() / 1000)) } });
    return json({ lead_id: r?.lead_id });
  } catch (e) {
    return error(e instanceof ErrorNegocio ? e.message : 'Error interno.', e instanceof ErrorNegocio ? 422 : 500);
  }
});
