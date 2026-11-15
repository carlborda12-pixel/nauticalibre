// Detección de embarcación y origen a partir del mensaje (link prellenado "(ref C9-IGH)" o texto libre)
export type Producto = { id: number; codigo: string; nombre: string; categoria: string };

export const ORIGENES: Record<string, string> = {
  IG: 'Instagram publicación', IGH: 'Instagram historia', FB: 'Facebook publicación', FBH: 'Facebook historia',
  WEB: 'Página web', QR: 'QR / cartel', ML: 'Mercado Libre', NC: 'Nación Conecta / Banco Nación',
};
const REF_RE = /\bref[:\s#-]*([CMEUOA]\d{1,3}|X)(?:[-_ ]([A-Z]{2,4}))?\b/i;

export const norm = (s: string) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9,.]+/g, ' ').replace(/\s+/g, ' ').trim();

// deno-lint-ignore no-explicit-any
export function detectar(texto: string, referral: any, productos: Producto[]) {
  let producto: Producto | null = null;
  let origen: string | null = null;
  let via: string | null = null;
  const m = String(texto || '').match(REF_RE);
  if (m) {
    producto = productos.find((p) => p.codigo === m[1].toUpperCase()) || null;
    if (m[2] && ORIGENES[m[2].toUpperCase()]) origen = ORIGENES[m[2].toUpperCase()];
    if (producto) via = 'ref';
  }
  if (referral) origen = referral.source_type === 'ad' ? 'Anuncio Meta' : (origen || 'Publicación Meta');
  if (!producto) {
    producto = buscarPorNombre([texto, referral?.headline, referral?.body].filter(Boolean).join(' '), productos);
    if (producto) via = 'nombre';
  }
  return { producto, origen: origen || 'Directo (sin link)', via };
}

const PRIORIDAD: Record<string, number> = { Casco: 3, 'Equipo armado': 2, Motor: 1 };
export function buscarPorNombre(texto: string, productos: Producto[]): Producto | null {
  const t = ` ${norm(texto)} `;
  if (t.trim().length < 3) return null;
  let best: Producto | null = null; let bestN = ''; let bestScore = 0;
  for (const p of productos) {
    if (!(p.categoria in PRIORIDAD)) continue;
    const n = norm(p.nombre); const tokens = n.split(' ');
    let score = 0;
    if (t.includes(` ${n} `)) score = 1000 + n.length;
    else {
      for (let k = tokens.length - 1; k >= 2; k--) {
        const pref = tokens.slice(0, k).join(' ');
        if (/\d/.test(pref) && t.includes(` ${pref} `)) { score = pref.length * 10 + PRIORIDAD[p.categoria]; break; }
      }
    }
    if (score > bestScore || (score === bestScore && score > 0 && n.length < bestN.length)) { best = p; bestN = n; bestScore = score; }
  }
  return best;
}
