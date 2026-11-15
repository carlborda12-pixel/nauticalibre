// Crea los usuarios iniciales en Supabase (una sola vez).
// Uso: SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/crear-usuarios.mjs
// La clave service_role está en Supabase → Project Settings → API. No la subas a GitHub ni la pongas en el panel.
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dominio = process.env.USUARIOS_DOMINIO || 'nautica.local';
if (!url || !key) { console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(url, key, { auth: { persistSession: false } });

const iniciales = [
  { nombre: 'Juanchi', usuario: 'juanchi', rol: 'vendedor' },
  { nombre: 'Jorge', usuario: 'jorge', rol: 'vendedor' },
  { nombre: 'Cristian', usuario: 'cristian', rol: 'vendedor' },
  { nombre: 'Gerencia', usuario: 'gerencia', rol: 'admin' },
  { nombre: 'Administración', usuario: 'admin', rol: 'admin' },
];
const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
const clave = () => Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join('');

const lineas = ['Claves iniciales — Náutica Aire Libre (cada uno la cambia en su primer ingreso)', ''];
for (const u of iniciales) {
  const { data: existe } = await sb.from('perfiles').select('id').eq('usuario', u.usuario).maybeSingle();
  if (existe) { console.log(`· ${u.usuario} ya existe, lo salteo`); continue; }
  const pass = clave();
  const { data, error } = await sb.auth.admin.createUser({ email: `${u.usuario}@${dominio}`, password: pass, email_confirm: true, user_metadata: { debe_cambiar_pass: true } });
  if (error) { console.error(`✗ ${u.usuario}: ${error.message}`); continue; }
  const { error: e2 } = await sb.from('perfiles').insert({ id: data.user.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, recibe_leads: u.rol === 'vendedor' });
  if (e2) { console.error(`✗ perfil ${u.usuario}: ${e2.message}`); await sb.auth.admin.deleteUser(data.user.id); continue; }
  lineas.push(`${u.nombre.padEnd(16)} usuario: ${u.usuario.padEnd(10)} clave: ${pass}`);
  console.log(`✓ ${u.usuario}`);
}
writeFileSync('credenciales-iniciales.txt', lineas.join('\n') + '\n', { mode: 0o600 });
console.log('\nClaves guardadas en credenciales-iniciales.txt. Repartilas por privado y después borrá el archivo.');
