// Webhook que configura Meta: recibe mensajes, ecos del celular (coexistencia) y estados de entrega.
import { admin, rpc } from '../_shared/supabase.ts';
import { firmaValida, parsearWebhook, contenido, wa } from '../_shared/whatsapp.ts';
import { procesarEntrante } from '../_shared/entrante.ts';

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificación inicial de Meta
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && wa.verifyToken &&
      url.searchParams.get('hub.verify_token') === wa.verifyToken;
    return ok ? new Response(url.searchParams.get('hub.challenge') || '', { status: 200 }) : new Response('Forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await firmaValida(raw, req.headers.get('X-Hub-Signature-256')))) return new Response('Unauthorized', { status: 401 });

  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response('ok'); }

  const sb = admin();
  for (const ev of parsearWebhook(body)) {
    try {
      if (ev.kind === 'message') await procesarEntrante(sb, ev);
      else if (ev.kind === 'echo') {
        const c = contenido(ev.msg);
        await rpc(sb, 'procesar_eco', { p: { wa_id: ev.waId, msg_id: ev.msg.id, tipo: c.tipo, cuerpo: c.cuerpo, media_id: c.media } });
      } else if (ev.kind === 'status') {
        await rpc(sb, 'procesar_estado', { p_msg: ev.waMsgId, p_estado: ev.status, p_error: ev.error });
      }
    } catch (e) { console.error('[webhook]', ev.kind, (e as Error).message); }
  }
  // Siempre 200: si devolvemos error, Meta reintenta y luego desactiva el webhook
  return new Response('ok', { status: 200 });
});
