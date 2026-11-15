// Cliente con permisos de servicio + identificación del usuario que llama
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export function admin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SB_SECRET_KEY')!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type Perfil = { id: string; nombre: string; usuario: string; rol: 'vendedor' | 'admin'; activo: boolean };

/** Valida el token de sesión del panel y devuelve el perfil activo, o null. */
export async function usuario(req: Request, sb: SupabaseClient): Promise<Perfil | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: p } = await sb.from('perfiles').select('id,nombre,usuario,rol,activo').eq('id', data.user.id).maybeSingle();
  return p && p.activo ? (p as Perfil) : null;
}

/** Llama a una función SQL y convierte el error de negocio en texto legible. */
export async function rpc<T = unknown>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new ErrorNegocio(error.message || 'Error en la base de datos');
  return data as T;
}

export class ErrorNegocio extends Error {}
