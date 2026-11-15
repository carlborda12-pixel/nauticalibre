# Náutica Aire Libre · Sistema de consultas por WhatsApp

Bandeja compartida de WhatsApp con asignación automática, reloj de respuesta y métricas de ventas. Desarrollado por **ApexTech**.

**Stack:** Supabase (Postgres + Auth + Edge Functions + Realtime + Cron) y panel web estático en Vercel (HTML/CSS/JS sin build, instalable como app).

👉 **Para ponerlo en producción seguí [GUIA.md](GUIA.md).**

## Estructura

```
supabase/
  migrations/
    ..._esquema.sql          Tablas, reglas de negocio en SQL, seguridad por filas (RLS), Realtime
    ..._catalogo.sql         463 productos de la planilla
    ..._reloj_y_avisos.sql   pg_cron (reloj cada 30 s) y pg_net (avisos push)
  functions/
    whatsapp-webhook/        Recibe mensajes de Meta (firma verificada)
    enviar/                  Envía respuestas y plantillas, marca como leído
    push/                    Avisos al celular (Web Push)
    media/                   Fotos/audios/documentos con permisos
    admin-usuarios/          Alta de usuarios y reseteo de claves
    simular/                 Consultas de prueba sin WhatsApp
    _shared/                 Código común (WhatsApp, detección de embarcación, etc.)
  config.toml
web/                         Panel (Vercel, Root Directory = web)
  config.js                  URL y clave pública de Supabase  ← completar
scripts/
  crear-usuarios.mjs         Usuarios iniciales
  generar-claves.mjs         Claves VAPID y secretos
test/                        Pruebas (Postgres real + Deno)
```

## Seguridad

- Todas las escrituras pasan por funciones SQL `security definer` que validan permisos. El navegador no puede escribir tablas directamente.
- RLS: cada vendedor solo puede leer las consultas libres y las suyas, incluso por Realtime. Gerencia y administración leen todo.
- Las funciones internas (entrada de mensajes, reloj, envíos) solo las ejecuta `service_role`.
- El webhook valida `X-Hub-Signature-256` con el App Secret de Meta y descarta mensajes duplicados.
- El token de WhatsApp y la clave `service_role` viven solo en los secretos de Supabase.
- El panel trae una CSP estricta (`web/vercel.json`) y el CSV escapa fórmulas para evitar inyección en Excel.

## Pruebas

```bash
# Reglas de negocio contra Postgres real (requiere un Postgres local)
PGHOST=/tmp/pg PGPORT=54329 npm test
# Módulos de las Edge Functions
DENO_NO_PACKAGE_JSON=1 deno test -A test/funciones.test.ts
```
