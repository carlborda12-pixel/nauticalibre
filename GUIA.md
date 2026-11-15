# Puesta en marcha — Náutica Aire Libre (Supabase + Vercel)

Guía paso a paso para dejar el sistema funcionando en producción. Los pasos 1 a 9 se pueden hacer **antes** de saber qué número de WhatsApp van a usar: el sistema arranca en **modo prueba** y se puede usar con el simulador. El paso 10 conecta WhatsApp cuando el cliente lo defina.

> Necesitás: Node 20 o superior, una cuenta en [supabase.com](https://supabase.com) y una en [vercel.com](https://vercel.com). La CLI de Supabase se usa con `npx supabase ...`, así que no hace falta instalarla aparte.

---

## 1. Crear el proyecto en Supabase

1. En Supabase: **New project**. Nombre: `nautica-leads`. Región: **South America (São Paulo)**, la más cercana a Misiones. Guardá la contraseña de la base de datos.
2. Cuando esté listo, anotá estos datos de **Project Settings → API** (o **API Keys**):
   - **Project URL**: `https://XXXX.supabase.co`. `XXXX` es el *project ref*.
   - **anon / publishable key**: va en el panel y es pública.
   - **service_role / secret key**: es **secreta**. Solo se usa en el paso 6, desde tu compu. No la subas a GitHub ni la pegues en el panel.

> Producción: usá el plan **Pro**. En el plan gratis, el proyecto se pausa tras 7 días sin actividad y los webhooks de WhatsApp fallarían.

## 2. Seguridad de Auth (importante)

En **Authentication → Sign In / Providers**:
- **Allow new users to sign up: OFF.** Solo gerencia crea usuarios desde el panel.
- Email: dejá el proveedor habilitado (los usuarios ingresan con usuario y clave; por dentro se usan emails internos `usuario@nautica.local`).

## 3. Subir la base de datos

Desde la carpeta del proyecto:

```bash
npm install
npx supabase login
npx supabase link --project-ref XXXX       # pide la contraseña de la base
npx supabase db push                       # aplica las 3 migraciones
```

Esto crea las tablas, las reglas (asignación, reloj de 20 min, zonas y titularidad), la seguridad por filas (RLS), el catálogo de 463 productos, el reloj automático cada 30 segundos (pg_cron) y el envío de avisos (pg_net).

## 4. Generar claves

```bash
npm run claves
```

Muestra las claves de avisos push (VAPID) y dos secretos aleatorios. Copialas en un archivo **`supabase/.env.produccion`**, que **no se sube** a GitHub porque está en `.gitignore`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:soporte@apextech.com.ar
PUSH_SECRET=...
WA_VERIFY_TOKEN=...
PANEL_ORIGIN=https://TU-PANEL.vercel.app
```

`PANEL_ORIGIN` es la dirección del panel en Vercel (paso 8). Si todavía no la sabés, poné `*` y cambiala después.

## 5. Secretos y funciones

```bash
npx supabase secrets set --env-file supabase/.env.produccion
npx supabase functions deploy
```

Si la CLI te pide confirmar, respondé que sí. Se publican 6 funciones:
- `whatsapp-webhook`: recibe los mensajes de Meta.
- `enviar`: manda mensajes desde el panel.
- `push`: envía los avisos al celular.
- `media`: muestra fotos y audios.
- `admin-usuarios`: alta de usuarios y reseteo de claves.
- `simular`: consultas de prueba.

Después, en el **SQL Editor** de Supabase, cargá en Vault el mismo `PUSH_SECRET` y la URL de la función de avisos:

```sql
select vault.create_secret('EL-MISMO-PUSH_SECRET', 'nautica_push_secret');
select vault.create_secret('https://XXXX.supabase.co/functions/v1/push', 'nautica_push_url');
```

## 6. Crear los usuarios

```bash
SUPABASE_URL=https://XXXX.supabase.co SUPABASE_SERVICE_ROLE_KEY=la-clave-secreta npm run usuarios
```

En Windows (PowerShell):
```powershell
$env:SUPABASE_URL="https://XXXX.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="la-clave-secreta"; npm run usuarios
```

Crea a Juanchi, Jorge y Cristian (vendedores), y a Gerencia y Administración. Las claves temporales quedan en `credenciales-iniciales.txt`. Cada uno la cambia en su primer ingreso. Repartilas por privado y **borrá el archivo**.

## 7. Configurar el panel

Editá **`web/config.js`**:

```js
window.NAUTICA_CONFIG = {
  supabaseUrl: 'https://XXXX.supabase.co',
  supabaseAnonKey: 'la-anon-key',
  vapidPublicKey: 'la VAPID_PUBLIC_KEY del paso 4',
  waNumber: '',            // cuando tengan número: 549 + área + número, ej. 5493764123456
  dominioUsuarios: 'nautica.local',
};
```

## 8. Publicar el panel en Vercel

1. Subí el proyecto a GitHub.
2. En Vercel: **Add New → Project**, elegí el repo.
3. **Root Directory: `web`**. Framework: **Other**. Sin build command.
4. **Deploy.** Te da la URL, por ejemplo `https://nautica-leads.vercel.app`.
5. Volvé al paso 4: poné esa URL en `PANEL_ORIGIN` y repetí `npx supabase secrets set --env-file supabase/.env.produccion`.

> El plan **Hobby** de Vercel es solo para uso personal y no comercial. Para un cliente corresponde **Pro**.

## 9. Probar

1. Entrá al panel como `gerencia` y cambiá la clave.
2. En **Configuración → Simulador de consultas**, simulá un mensaje desde un número 351… (le llega a todos), 376… (a Jorge) o 362… (a Juanchi).
3. En otro navegador, entrá como un vendedor: la consulta aparece sola gracias a Realtime. Tomala, respondé, cerrala como venta y mirá **Métricas**.
4. En el celular: abrí el panel, tocá **🔔 Activar avisos** y agregalo a la pantalla de inicio. En iPhone los avisos funcionan solo si está agregado a la pantalla de inicio (iOS 16.4 o posterior).

Mientras WhatsApp no esté conectado, arriba aparece **MODO PRUEBA** y los mensajes no salen.

## 10. Conectar WhatsApp (cuando el cliente defina el número)

1. **developers.facebook.com → Crear app → tipo Business → agregar WhatsApp**, con el Meta Business del cliente (conviene que esté verificado).
2. Agregá el número:
   - **Número nuevo:** se registra directo.
   - **Número actual de WhatsApp Business:** elegí **coexistencia**. Pueden seguir usando la app del celular, pero lo que respondan desde ahí queda sin nombre de vendedor.
3. En **Business Settings → Usuarios del sistema**, creá uno con acceso a la cuenta de WhatsApp y generá un **token permanente** con los permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
4. Agregá a `supabase/.env.produccion`:
   ```
   WA_TOKEN=...
   WA_PHONE_NUMBER_ID=...      # de WhatsApp → API Setup
   WA_APP_SECRET=...           # de App Settings → Basic
   ```
   y corré `npx supabase secrets set --env-file supabase/.env.produccion`.
5. En **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://XXXX.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: el `WA_VERIFY_TOKEN` del paso 4
   - Suscribí **messages** y, si usan coexistencia, **smb_message_echoes**.
6. Poné el número en `waNumber` de `web/config.js` y volvé a publicar en Vercel, que lo hace solo al subir a GitHub.
7. Desde otro celular, escribí al número: tiene que aparecer en el panel. **MODO PRUEBA** desaparece.

**Plantilla para retomar contacto (opcional).** Pasadas 24 h del último mensaje del cliente, WhatsApp solo permite plantillas aprobadas. Creá una en Meta (categoría *utility*), por ejemplo `Hola {{1}}, te escribimos de Náutica Aire Libre por tu consulta. ¿Seguís interesado?`, y cargá su nombre en **Configuración → Mensajes automáticos**.

---

## Costos mensuales de referencia

| Servicio | Plan | Para qué |
|---|---|---|
| Supabase | Pro | Base de datos, funciones, tiempo real, reloj; sin pausas y con backups diarios |
| Vercel | Pro | Panel web (uso comercial) |
| Meta (WhatsApp) | Por uso | Responder consultas del cliente dentro de 24 h no tiene costo con la tarifa actual; las plantillas se cobran por mensaje |

## Si algo falla

- **No llegan mensajes:** en Supabase → Edge Functions → `whatsapp-webhook` → Logs. Un 401 indica que `WA_APP_SECRET` está mal.
- **No llegan avisos al celular:** revisá los secretos de Vault (paso 5) y los logs de la función `push`.
- **El reloj no libera consultas:** en el SQL Editor, `select * from cron.job_run_details order by start_time desc limit 5;`
- **"Usuario o clave incorrectos":** gerencia puede resetear la clave desde Configuración → Usuarios.
