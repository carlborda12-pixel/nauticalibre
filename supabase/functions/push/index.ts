// Envía los avisos push de la tabla "notificaciones". La llama un trigger de la base (pg_net) con un secreto compartido.
import webpush from 'npm:web-push@3.6.7';
import { admin } from '../_shared/supabase.ts';

const SECRETO = Deno.env.get('PUSH_SECRET') || '';
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') || 'mailto:soporte@apextech.com.ar',
  Deno.env.get('VAPID_PUBLIC_KEY') || '', Deno.env.get('VAPID_PRIVATE_KEY') || '');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!SECRETO || req.headers.get('x-nautica-secret') !== SECRETO) return new Response('Unauthorized', { status: 401 });
  const { id } = await req.json().catch(() => ({ id: null }));
  if (!id) return new Response('Falta id', { status: 400 });

  const sb = admin();
  const { data: n } = await sb.from('notificaciones').select('*').eq('id', id).is('enviada_at', null).maybeSingle();
  if (!n) return new Response('ok');
  const { data: subs } = await sb.from('push_subs').select('id,data').in('user_id', n.destinatarios);
  const payload = JSON.stringify({ titulo: n.titulo, cuerpo: n.cuerpo, url: n.url, tag: n.tag });
  let enviados = 0;
  await Promise.all((subs || []).map(async (s) => {
    try { await webpush.sendNotification(s.data, payload, { TTL: 600, urgency: 'high' }); enviados++; }
    catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from('push_subs').delete().eq('id', s.id);
    }
  }));
  await sb.from('notificaciones').update({ enviada_at: new Date().toISOString() }).eq('id', id);
  return new Response(JSON.stringify({ enviados }), { headers: { 'Content-Type': 'application/json' } });
});
