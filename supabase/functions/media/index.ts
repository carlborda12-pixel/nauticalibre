// Descarga fotos, audios y documentos de WhatsApp sin exponer el token de Meta, verificando permisos.
import { admin, usuario, rpc } from '../_shared/supabase.ts';
import { cors, error } from '../_shared/cors.ts';
import { descargarMedia } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = admin();
  const yo = await usuario(req, sb);
  if (!yo) return error('Sesión vencida.', 401);
  const id = new URL(req.url).searchParams.get('id') || '';
  const { data: m } = await sb.from('mensajes').select('lead_id').eq('media_id', id).maybeSingle();
  if (!m) return error('No encontrado', 404);
  try { await rpc(sb, 'exigir_ver', { p_user: yo.id, p_lead: m.lead_id }); } catch { return error('No encontrado', 404); }
  const f = await descargarMedia(id);
  if (!f) return error('No disponible', 404);
  return new Response(f.datos, { headers: { ...cors, 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400' } });
});
