// Genera las claves para avisos push (VAPID) y los secretos internos. Correr una vez.
// Uso: node scripts/generar-claves.mjs
import webpush from 'web-push';
import crypto from 'node:crypto';
const v = webpush.generateVAPIDKeys();
const r = () => crypto.randomBytes(24).toString('base64url');
console.log(`# 1) Secretos de las Edge Functions (supabase secrets set ...)
VAPID_PUBLIC_KEY=${v.publicKey}
VAPID_PRIVATE_KEY=${v.privateKey}
VAPID_SUBJECT=mailto:soporte@apextech.com.ar
PUSH_SECRET=${r()}
WA_VERIFY_TOKEN=${r()}

# 2) En web/config.js -> vapidPublicKey: '${v.publicKey}'
# 3) En el SQL Editor (Vault), con el mismo PUSH_SECRET:
#    select vault.create_secret('<PUSH_SECRET>', 'nautica_push_secret');
#    select vault.create_secret('https://<PROYECTO>.supabase.co/functions/v1/push', 'nautica_push_url');`);
