// Alta de usuarios y reseteo de claves (requiere la API de administración de Supabase Auth).
import { admin, usuario } from '../_shared/supabase.ts';
import { cors, json, error } from '../_shared/cors.ts';

const DOMINIO = Deno.env.get('USUARIOS_DOMINIO') || 'nautica.local';
const claveTemporal = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => abc[b % abc.length]).join('');
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = admin();
  const yo = await usuario(req, sb);
  if (!yo) return error('Sesión vencida.', 401);
  if (yo.rol !== 'admin') return error('Solo gerencia/administración.', 403);
  const b = await req.json().catch(() => ({}));

  if (b.accion === 'crear') {
    const nombre = String(b.nombre || '').trim().slice(0, 40);
    const user = String(b.usuario || '').trim().toLowerCase();
    const rol = b.rol === 'admin' ? 'admin' : 'vendedor';
    if (!nombre || !/^[a-z0-9._-]{3,30}$/.test(user)) return error('Nombre y usuario (3 a 30 letras o números) son obligatorios.');
    const { data: existe } = await sb.from('perfiles').select('id').eq('usuario', user).maybeSingle();
    if (existe) return error('Ese usuario ya existe.');
    const clave = claveTemporal();
    const { data, error: e } = await sb.auth.admin.createUser({ email: `${user}@${DOMINIO}`, password: clave, email_confirm: true });
    if (e || !data.user) return error(`No se pudo crear: ${e?.message}`);
    const { error: e2 } = await sb.from('perfiles').insert({ id: data.user.id, nombre, usuario: user, rol, recibe_leads: rol === 'vendedor' });
    if (e2) { await sb.auth.admin.deleteUser(data.user.id); return error(`No se pudo crear el perfil: ${e2.message}`); }
    return json({ clave });
  }

  if (b.accion === 'reset') {
    const clave = claveTemporal();
    const { error: e } = await sb.auth.admin.updateUserById(String(b.id), { password: clave, user_metadata: { debe_cambiar_pass: true } });
    if (e) return error(`No se pudo resetear: ${e.message}`);
    return json({ clave });
  }

  return error('Acción desconocida.');
});
