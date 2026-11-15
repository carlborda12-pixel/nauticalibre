// CORS para que el panel (Vercel) pueda llamar a las funciones
const origen = Deno.env.get('PANEL_ORIGIN') || '*';

export const cors = {
  'Access-Control-Allow-Origin': origen,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Vary': 'Origin',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export function error(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}
