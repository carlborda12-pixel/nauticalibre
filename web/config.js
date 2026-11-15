// Configuración pública del panel. Completar con los datos del proyecto de Supabase.
// La "anon key" (o publishable key) es pública por diseño: la seguridad la dan RLS y las funciones.
// NUNCA pongas acá la service_role key.
window.NAUTICA_CONFIG = {
  supabaseUrl: 'https://TU-PROYECTO.supabase.co',
  supabaseAnonKey: 'TU-ANON-KEY',
  vapidPublicKey: 'TU-VAPID-PUBLIC-KEY',   // la genera: npm run claves
  waNumber: '',                           // número de WhatsApp de la empresa con 549, ej. 5493764123456
  dominioUsuarios: 'nautica.local',
};
