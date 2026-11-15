// Procesa un mensaje entrante: detecta producto/origen, lo registra y manda la bienvenida si corresponde.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { contenido, enviarTexto } from './whatsapp.ts';
import { detectar, type Producto } from './catalogo.ts';
import { rpc } from './supabase.ts';

let cache: { productos: Producto[]; at: number } | null = null;
async function productos(sb: SupabaseClient): Promise<Producto[]> {
  if (cache && Date.now() - cache.at < 10 * 60e3) return cache.productos;
  const { data, error } = await sb.from('catalogo').select('id,codigo,nombre,categoria').eq('activo', true);
  if (error) throw error;
  cache = { productos: data as Producto[], at: Date.now() };
  return cache.productos;
}

// deno-lint-ignore no-explicit-any
export async function procesarEntrante(sb: SupabaseClient, ev: { waId: string; nombre: string | null; msg: any }) {
  const { tipo, cuerpo, media } = contenido(ev.msg);
  const det = detectar(cuerpo, ev.msg.referral || null, await productos(sb));
  // deno-lint-ignore no-explicit-any
  const r = await rpc<any>(sb, 'procesar_entrante', { p: {
    wa_id: ev.waId, nombre: ev.nombre, msg_id: ev.msg.id || null, tipo, cuerpo, media_id: media,
    ts: ev.msg.timestamp ? Number(ev.msg.timestamp) * 1000 : Date.now(), referral: ev.msg.referral || null,
    producto_id: det.producto?.id ?? null, origen: det.origen, deteccion: det.via,
  } });
  if (r?.bienvenida) {
    try {
      const env = await enviarTexto(r.wa_id, r.bienvenida);
      await rpc(sb, 'registrar_salida', { p_lead: r.lead_id, p_user: null, p_texto: r.bienvenida, p_wa_msg_id: env.id, p_estado: env.simulado ? 'simulado' : 'sent', p_tipo: 'auto' });
    } catch (e) { console.error('[bienvenida]', (e as Error).message); }
  }
  return r;
}
