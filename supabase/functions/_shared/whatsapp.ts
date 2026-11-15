// WhatsApp Cloud API (Meta): firma del webhook, parseo, envío y multimedia.
const env = (k: string, d = '') => (Deno.env.get(k) ?? d).trim();

export const wa = {
  get token() { return env('WA_TOKEN'); },
  get phoneId() { return env('WA_PHONE_NUMBER_ID'); },
  get appSecret() { return env('WA_APP_SECRET'); },
  get verifyToken() { return env('WA_VERIFY_TOKEN'); },
  get version() { return env('WA_API_VERSION', 'v23.0'); },
  get conectado() { return !!(this.token && this.phoneId); },
};
const graph = (p: string) => `https://graph.facebook.com/${wa.version}/${p}`;
export const ERROR_VENTANA = 131047;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret). */
export async function firmaValida(raw: Uint8Array<ArrayBuffer>, header: string | null, secreto = wa.appSecret): Promise<boolean> {
  if (!secreto || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const esperado = 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, raw));
  if (esperado.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) diff |= esperado.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

// deno-lint-ignore no-explicit-any
type Msg = Record<string, any>;
export type Evento =
  | { kind: 'message'; waId: string; nombre: string | null; msg: Msg }
  | { kind: 'echo'; waId: string; msg: Msg }
  | { kind: 'status'; waMsgId: string; status: string; error: string | null };

// deno-lint-ignore no-explicit-any
export function parsearWebhook(body: any): Evento[] {
  const out: Evento[] = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (ch.field === 'messages') {
        const nombres = Object.fromEntries((v.contacts || []).map((c: Msg) => [c.wa_id, c.profile?.name]));
        for (const msg of v.messages || []) out.push({ kind: 'message', waId: msg.from, nombre: nombres[msg.from] || null, msg });
        for (const st of v.statuses || []) {
          const e = st.errors?.[0];
          out.push({ kind: 'status', waMsgId: st.id, status: st.status, error: e ? `${e.code} ${e.title}` : null });
        }
      } else if (ch.field === 'smb_message_echoes') {
        for (const msg of v.message_echoes || []) out.push({ kind: 'echo', waId: msg.to, msg });
      }
    }
  }
  return out;
}

export function contenido(msg: Msg): { tipo: string; cuerpo: string; media: string | null } {
  const t = msg.type;
  switch (t) {
    case 'text': return { tipo: 'text', cuerpo: msg.text?.body || '', media: null };
    case 'image': case 'video': case 'document': case 'sticker':
      return { tipo: t, cuerpo: msg[t]?.caption || msg[t]?.filename || '', media: msg[t]?.id || null };
    case 'audio': return { tipo: 'audio', cuerpo: '', media: msg.audio?.id || null };
    case 'location': return { tipo: 'location', cuerpo: `📍 ${msg.location?.name || ''} ${msg.location?.latitude},${msg.location?.longitude}`.trim(), media: null };
    case 'button': return { tipo: 'text', cuerpo: msg.button?.text || '', media: null };
    case 'interactive': {
      const r = msg.interactive?.button_reply || msg.interactive?.list_reply;
      return { tipo: 'text', cuerpo: r?.title || '', media: null };
    }
    case 'contacts': return { tipo: 'contacts', cuerpo: '👤 Contacto compartido', media: null };
    case 'reaction': return { tipo: 'reaction', cuerpo: msg.reaction?.emoji || '', media: null };
    default: return { tipo: t || 'unknown', cuerpo: '[Mensaje no soportado]', media: null };
  }
}

export class ErrorWhatsApp extends Error { constructor(msg: string, public code?: number) { super(msg); } }

async function post(path: string, payload: unknown) {
  const r = await fetch(graph(path), {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErrorWhatsApp(data?.error?.error_user_msg || data?.error?.message || `HTTP ${r.status}`, data?.error?.code);
  return data;
}

/** Sin credenciales (modo prueba) no envía nada y devuelve un id simulado. */
export async function enviarTexto(waId: string, texto: string): Promise<{ id: string; simulado: boolean }> {
  if (!wa.conectado) return { id: `sim-${crypto.randomUUID()}`, simulado: true };
  const d = await post(`${wa.phoneId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId, type: 'text', text: { preview_url: true, body: texto } });
  return { id: d.messages?.[0]?.id, simulado: false };
}

export async function enviarPlantilla(waId: string, nombre: string, idioma: string, variables: string[]) {
  if (!wa.conectado) return { id: `sim-${crypto.randomUUID()}`, simulado: true };
  const components = variables.length ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: v })) }] : undefined;
  const d = await post(`${wa.phoneId}/messages`, { messaging_product: 'whatsapp', to: waId, type: 'template', template: { name: nombre, language: { code: idioma }, components } });
  return { id: d.messages?.[0]?.id, simulado: false };
}

export async function marcarLeido(waMsgId: string) {
  if (!wa.conectado || !waMsgId) return;
  try { await post(`${wa.phoneId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: waMsgId }); } catch { /* no crítico */ }
}

export async function descargarMedia(mediaId: string): Promise<{ mime: string; datos: ArrayBuffer } | null> {
  if (!wa.conectado) return null;
  const meta = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${wa.token}` } }).then((r) => r.json());
  if (!meta?.url) return null;
  const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${wa.token}` } });
  if (!r.ok) return null;
  return { mime: meta.mime_type || r.headers.get('content-type') || 'application/octet-stream', datos: await r.arrayBuffer() };
}
