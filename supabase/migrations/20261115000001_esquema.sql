-- =====================================================================
-- Náutica Aire Libre · Sistema de consultas por WhatsApp — ApexTech
-- Esquema, seguridad (RLS) y reglas de negocio en Postgres (Supabase)
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  usuario text not null unique,
  rol text not null check (rol in ('vendedor','admin')),
  recibe_leads boolean not null default true,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.catalogo (
  id serial primary key,
  codigo text not null unique,
  nombre text not null,
  categoria text not null,
  activo boolean not null default true
);

create table if not exists public.contactos (
  id bigserial primary key,
  wa_id text not null unique,
  telefono text not null,
  nombre text,
  localidad text,
  provincia text,
  titular_id uuid references public.perfiles(id),
  ultima_actividad timestamptz,
  vendido boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.leads (
  id bigserial primary key,
  contacto_id bigint not null references public.contactos(id),
  producto_id int references public.catalogo(id),
  origen text not null default 'Directo (sin link)',
  referral jsonb,
  estado text not null check (estado in ('pendiente','asignado','cerrado')),
  etapa text not null default 'Nueva consulta',
  resultado text check (resultado in ('vendido','perdido')),
  monto_usd numeric(12,2),
  motivo_asignacion text,
  asignado_a uuid references public.perfiles(id),
  asignado_at timestamptz,
  vence_at timestamptz,
  alerta_pool_enviada boolean not null default false,
  primera_respuesta_at timestamptz,
  primera_respuesta_por uuid references public.perfiles(id),
  ultimo_in_at timestamptz,
  ultimo_out_at timestamptz,
  no_leidos int not null default 0,
  created_at timestamptz not null default now(),
  cerrado_at timestamptz
);
create index if not exists leads_estado_idx on public.leads(estado);
create index if not exists leads_asignado_idx on public.leads(asignado_a);
create index if not exists leads_contacto_idx on public.leads(contacto_id);
create index if not exists leads_created_idx on public.leads(created_at);
create index if not exists leads_vence_idx on public.leads(vence_at) where vence_at is not null;

create table if not exists public.mensajes (
  id bigserial primary key,
  lead_id bigint not null references public.leads(id) on delete cascade,
  direccion text not null check (direccion in ('in','out','nota')),
  user_id uuid references public.perfiles(id),
  tipo text not null default 'text',
  cuerpo text,
  media_id text,
  wa_msg_id text unique,
  estado text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists mensajes_lead_idx on public.mensajes(lead_id, created_at);

create table if not exists public.eventos (
  id bigserial primary key,
  lead_id bigint references public.leads(id) on delete cascade,
  tipo text not null,
  user_id uuid references public.perfiles(id),
  detalle text,
  created_at timestamptz not null default now()
);
create index if not exists eventos_lead_idx on public.eventos(lead_id);
create index if not exists eventos_created_idx on public.eventos(created_at);

create table if not exists public.push_subs (
  id bigserial primary key,
  user_id uuid not null references public.perfiles(id) on delete cascade,
  endpoint text not null unique,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ajustes (
  clave text primary key,
  valor jsonb not null
);

-- Bandeja de salida de avisos push: un trigger la envía a la Edge Function "push"
create table if not exists public.notificaciones (
  id bigserial primary key,
  destinatarios uuid[] not null,
  titulo text not null,
  cuerpo text,
  url text,
  tag text,
  created_at timestamptz not null default now(),
  enviada_at timestamptz
);

insert into public.ajustes(clave, valor) values
  ('minutos_respuesta', '20'),
  ('dias_titular', '30'),
  ('horario', '{"activo": true, "dias": [1,2,3,4,5,6], "desde": "08:00", "hasta": "20:00"}'),
  ('zonas', '{"activo": true, "lista": [{"nombre": "Posadas", "prefijos": ["376"], "titular": "Jorge"}, {"nombre": "Resistencia", "prefijos": ["362"], "titular": "Juanchi"}]}'),
  ('plantilla', '{"nombre": "", "idioma": "es_AR", "usa_nombre": true, "texto": ""}'),
  ('bienvenida', '{"activo": false, "texto": "¡Hola! Gracias por escribir a Náutica Aire Libre. En unos minutos te responde un asesor."}'),
  ('zona_horaria', '"America/Argentina/Buenos_Aires"')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function public.ms(t timestamptz) returns bigint
language sql immutable as $$ select (extract(epoch from t) * 1000)::bigint $$;

create or replace function public.ajuste(p_clave text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select valor from public.ajustes where clave = p_clave
$$;

create or replace function public.origenes() returns jsonb
language sql immutable as $$
  select '[{"codigo":"IG","nombre":"Instagram publicación"},{"codigo":"IGH","nombre":"Instagram historia"},
           {"codigo":"FB","nombre":"Facebook publicación"},{"codigo":"FBH","nombre":"Facebook historia"},
           {"codigo":"WEB","nombre":"Página web"},{"codigo":"QR","nombre":"QR / cartel"},
           {"codigo":"ML","nombre":"Mercado Libre"},{"codigo":"NC","nombre":"Nación Conecta / Banco Nación"}]'::jsonb
$$;

create or replace function public.origenes_todos() returns jsonb
language sql immutable as $$
  select (select jsonb_agg(o->>'nombre') from jsonb_array_elements(public.origenes()) o)
         || '["Anuncio Meta","Publicación Meta","Directo (sin link)","Otro"]'::jsonb
$$;

create or replace function public.etapas() returns jsonb
language sql immutable as $$
  select '["Nueva consulta","Llamada/contacto","Presupuesto enviado","Oferta enviada","Visita","Otro movimiento"]'::jsonb
$$;

-- Error de negocio legible en el panel
create or replace function public.falla(p_msg text) returns void
language plpgsql as $$ begin raise exception using message = p_msg, errcode = 'P0001'; end $$;

-- Perfil del usuario autenticado (o error)
create or replace function public.yo() returns public.perfiles
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.perfiles;
begin
  select * into p from public.perfiles where id = auth.uid() and activo;
  if p.id is null then perform public.falla('Sesión vencida. Volvé a ingresar.'); end if;
  return p;
end $$;

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and activo and rol = 'admin')
$$;

create or replace function public.receptores() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(id), '{}') from public.perfiles where activo and recibe_leads
$$;

create or replace function public.admins() returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(id), '{}') from public.perfiles where activo and rol = 'admin'
$$;

create or replace function public.log_evento(p_lead bigint, p_tipo text, p_user uuid default null, p_detalle text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.eventos(lead_id, tipo, user_id, detalle) values (p_lead, p_tipo, p_user, p_detalle)
$$;

create or replace function public.titulo_lead(p_lead bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(c.nombre, '+' || c.wa_id) || coalesce(' · ' || p.nombre, '')
  from public.leads l join public.contactos c on c.id = l.contacto_id left join public.catalogo p on p.id = l.producto_id
  where l.id = p_lead
$$;

create or replace function public.notificar(p_dest uuid[], p_titulo text, p_cuerpo text, p_url text, p_tag text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_dest is null or cardinality(p_dest) = 0 then return; end if;
  insert into public.notificaciones(destinatarios, titulo, cuerpo, url, tag)
  values ((select array_agg(distinct d) from unnest(p_dest) d where d is not null), p_titulo, p_cuerpo, p_url, p_tag);
end $$;

-- Teléfono argentino: 549 + área + número -> 10 dígitos (igual que TelNorm de la planilla)
create or replace function public.telefono_nacional(p_wa text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p_wa, ''), '\D', '', 'g');
begin
  if d like '549%' then d := substr(d, 4);
  elsif d like '54%' then d := substr(d, 3); end if;
  if d like '0%' then d := substr(d, 2); end if;
  if length(d) > 10 then d := right(d, 10); end if;
  return d;
end $$;

-- Suma minutos contando solo dentro del horario de atención (si está activo)
create or replace function public.vencimiento(p_desde timestamptz, p_min numeric, p_horario jsonb default null)
returns timestamptz language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  h jsonb := coalesce(p_horario, public.ajuste('horario'));
  tz text := coalesce(public.ajuste('zona_horaria') #>> '{}', 'America/Argentina/Buenos_Aires');
  rem interval := make_interval(secs => p_min * 60);
  t timestamptz := p_desde;
  loc timestamp; dia int; desde_d interval; hasta_d interval; m interval; disp interval; lab boolean;
begin
  if not coalesce((h->>'activo')::boolean, false) or jsonb_array_length(coalesce(h->'dias', '[]')) = 0 then
    return p_desde + rem;
  end if;
  desde_d := (h->>'desde')::time - time '00:00';
  hasta_d := (h->>'hasta')::time - time '00:00';
  if hasta_d <= desde_d then return p_desde + rem; end if;
  for i in 1..40 loop
    loc := t at time zone tz;
    dia := extract(dow from loc)::int;
    m := loc - date_trunc('day', loc);
    lab := (h->'dias') @> to_jsonb(dia);
    if lab and m >= desde_d and m < hasta_d then
      disp := hasta_d - m;
      if rem <= disp then return t + rem; end if;
      rem := rem - disp; t := t + disp;
    elsif lab and m < desde_d then
      t := t + (desde_d - m);
    else
      t := t + (interval '1 day' - m);
    end if;
  end loop;
  return p_desde + make_interval(secs => p_min * 60);
end $$;

create or replace function public.minutos_respuesta() returns int
language sql stable as $$ select coalesce((public.ajuste('minutos_respuesta') #>> '{}')::int, 20) $$;

-- ---------------------------------------------------------------------
-- Visibilidad
-- ---------------------------------------------------------------------
create or replace function public.puede_ver(p_user uuid, l public.leads) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.perfiles p where p.id = p_user and p.activo and
    (p.rol = 'admin' or l.estado = 'pendiente' or l.asignado_a = p_user))
$$;

create or replace function public.exigir_ver(p_user uuid, p_lead bigint) returns public.leads
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l public.leads;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null then perform public.falla('No existe ese lead.'); end if;
  if not public.puede_ver(p_user, l) then perform public.falla('Este cliente lo está atendiendo otro vendedor.'); end if;
  return l;
end $$;

create or replace function public.es_admin_id(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.perfiles where id = p_user and activo and rol = 'admin')
$$;

-- ---------------------------------------------------------------------
-- Entrada de mensajes (la llama la Edge Function del webhook, con service_role)
-- ---------------------------------------------------------------------
create or replace function public.destino_inicial(c public.contactos) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  dias int := coalesce((public.ajuste('dias_titular') #>> '{}')::int, 30);
  z jsonb := public.ajuste('zonas');
  zona jsonb; pref text; u public.perfiles; nac text := public.telefono_nacional(c.wa_id);
begin
  if c.titular_id is not null and c.ultima_actividad > now() - make_interval(days => dias) then
    select * into u from public.perfiles where id = c.titular_id and activo;
    if u.id is not null then return jsonb_build_object('user', u.id, 'motivo', 'titular'); end if;
  end if;
  if coalesce((z->>'activo')::boolean, false) then
    for zona in select * from jsonb_array_elements(coalesce(z->'lista', '[]')) loop
      for pref in select jsonb_array_elements_text(coalesce(zona->'prefijos', '[]')) loop
        if pref <> '' and nac like pref || '%' then
          select * into u from public.perfiles where activo and lower(nombre) = lower(zona->>'titular') limit 1;
          if u.id is not null then return jsonb_build_object('user', u.id, 'motivo', 'zona ' || (zona->>'nombre')); end if;
        end if;
      end loop;
    end loop;
  end if;
  return null;
end $$;

-- p: {wa_id, nombre, msg_id, tipo, cuerpo, media_id, ts (ms), referral, producto_id, origen, deteccion}
create or replace function public.procesar_entrante(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.contactos; l public.leads; dest jsonb; nuevo boolean := false;
  ts timestamptz := coalesce(to_timestamp((p->>'ts')::numeric / 1000), now());
  preview text; b jsonb; tit text;
begin
  if p->>'msg_id' is not null and exists (select 1 from public.mensajes where wa_msg_id = p->>'msg_id') then
    return jsonb_build_object('duplicado', true);
  end if;
  if coalesce(p->>'tipo', 'text') = 'reaction' then return jsonb_build_object('ignorado', true); end if;

  insert into public.contactos(wa_id, telefono, nombre)
  values (p->>'wa_id', public.telefono_nacional(p->>'wa_id'), nullif(p->>'nombre', ''))
  on conflict (wa_id) do update set nombre = coalesce(public.contactos.nombre, excluded.nombre)
  returning * into c;
  perform 1 from public.contactos where id = c.id for update;

  select * into l from public.leads where contacto_id = c.id and estado <> 'cerrado' order by id desc limit 1;
  if l.id is null then
    nuevo := true;
    dest := public.destino_inicial(c);
    insert into public.leads(contacto_id, producto_id, origen, referral, estado, motivo_asignacion, asignado_a, asignado_at, vence_at, created_at)
    values (c.id, (p->>'producto_id')::int, coalesce(nullif(p->>'origen', ''), 'Directo (sin link)'), p->'referral',
            case when dest is null then 'pendiente' else 'asignado' end, dest->>'motivo', (dest->>'user')::uuid,
            case when dest is null then null else now() end, public.vencimiento(now(), public.minutos_respuesta()), now())
    returning * into l;
    perform public.log_evento(l.id, 'creado', null, jsonb_build_object('origen', l.origen,
      'producto', (select nombre from public.catalogo where id = l.producto_id), 'deteccion', p->>'deteccion')::text);
    if dest is not null then perform public.log_evento(l.id, 'asignado', (dest->>'user')::uuid, dest->>'motivo'); end if;
  end if;

  insert into public.mensajes(lead_id, direccion, tipo, cuerpo, media_id, wa_msg_id, created_at)
  values (l.id, 'in', coalesce(p->>'tipo', 'text'), p->>'cuerpo', p->>'media_id', p->>'msg_id', ts);
  update public.leads set ultimo_in_at = ts, no_leidos = no_leidos + 1 where id = l.id returning * into l;

  preview := case when coalesce(p->>'tipo', 'text') = 'text' then left(coalesce(p->>'cuerpo', ''), 120)
                  else '[' || (p->>'tipo') || '] ' || coalesce(p->>'cuerpo', '') end;
  tit := public.titulo_lead(l.id);
  if nuevo and l.estado = 'pendiente' then
    perform public.notificar(public.receptores(), '🛥️ Nueva consulta — tomala', tit || E'\n' || preview, '/#lead/' || l.id, 'lead-' || l.id);
  elsif nuevo then
    perform public.notificar(array[l.asignado_a], '🛥️ Consulta para vos (' || l.motivo_asignacion || ')', tit || E'\n' || preview, '/#lead/' || l.id, 'lead-' || l.id);
  elsif l.estado = 'asignado' then
    perform public.notificar(array[l.asignado_a], '💬 ' || tit, preview, '/#lead/' || l.id, 'lead-' || l.id);
  else
    perform public.notificar(public.receptores(), '💬 ' || tit, preview, '/#lead/' || l.id, 'lead-' || l.id);
  end if;

  b := public.ajuste('bienvenida');
  return jsonb_build_object('lead_id', l.id, 'nuevo', nuevo, 'estado', l.estado, 'wa_id', c.wa_id,
    'bienvenida', case when nuevo and coalesce((b->>'activo')::boolean, false) and coalesce(b->>'texto', '') <> '' then b->>'texto' end);
end $$;

-- Mensaje escrito desde la app del celular con el mismo número (coexistencia)
create or replace function public.procesar_eco(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.contactos; l public.leads;
begin
  if p->>'msg_id' is not null and exists (select 1 from public.mensajes where wa_msg_id = p->>'msg_id') then return; end if;
  select * into c from public.contactos where wa_id = p->>'wa_id';
  if c.id is null then return; end if;
  select * into l from public.leads where contacto_id = c.id and estado <> 'cerrado' order by id desc limit 1;
  if l.id is null then return; end if;
  insert into public.mensajes(lead_id, direccion, tipo, cuerpo, media_id, wa_msg_id, estado)
  values (l.id, 'out', coalesce(p->>'tipo', 'text'), p->>'cuerpo', p->>'media_id', p->>'msg_id', 'celular');
  update public.leads set ultimo_out_at = now(),
    vence_at = case when primera_respuesta_at is null then null else vence_at end,
    primera_respuesta_at = coalesce(primera_respuesta_at, now())
  where id = l.id;
  perform public.log_evento(l.id, 'respuesta_celular', null, 'Respondido desde la app del celular (sin vendedor identificado)');
end $$;

create or replace function public.procesar_estado(p_msg text, p_estado text, p_error text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare actual text; orden jsonb := '{"simulado":0,"sent":1,"delivered":2,"read":3,"failed":4}';
begin
  select estado into actual from public.mensajes where wa_msg_id = p_msg;
  if not found then return; end if;
  if p_estado <> 'failed' and coalesce((orden->>actual)::int, -1) >= coalesce((orden->>p_estado)::int, 0) then return; end if;
  update public.mensajes set estado = p_estado, error = p_error where wa_msg_id = p_msg;
end $$;

-- ---------------------------------------------------------------------
-- Acciones de los usuarios
-- ---------------------------------------------------------------------
create or replace function public.tomar_lead_de(p_lead bigint, p_user uuid) returns public.leads
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.leads; quien text;
begin
  update public.leads set estado = 'asignado', asignado_a = p_user, asignado_at = now(), motivo_asignacion = 'tomado',
    vence_at = case when primera_respuesta_at is null then public.vencimiento(now(), public.minutos_respuesta()) end,
    alerta_pool_enviada = false
  where id = p_lead and estado = 'pendiente'
  returning * into l;
  if l.id is null then
    select p.nombre into quien from public.leads x left join public.perfiles p on p.id = x.asignado_a where x.id = p_lead;
    if not exists (select 1 from public.leads where id = p_lead) then perform public.falla('No existe ese lead.'); end if;
    perform public.falla(case when quien is not null then 'Ya lo tomó ' || quien || '.' else 'Este lead ya no está disponible.' end);
  end if;
  perform public.log_evento(p_lead, 'tomado', p_user);
  return l;
end $$;

create or replace function public.tomar_lead(p_lead bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo();
begin perform public.tomar_lead_de(p_lead, me.id); end $$;

create or replace function public.liberar_lead(p_lead bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads;
begin
  l := public.exigir_ver(me.id, p_lead);
  if l.estado <> 'asignado' then perform public.falla('El lead no está asignado.'); end if;
  if me.rol <> 'admin' and l.asignado_a <> me.id then perform public.falla('No es tuyo.'); end if;
  update public.leads set estado = 'pendiente', asignado_a = null, asignado_at = null, motivo_asignacion = null,
    vence_at = public.vencimiento(now(), public.minutos_respuesta()), alerta_pool_enviada = false
  where id = p_lead;
  perform public.log_evento(p_lead, 'liberado', me.id);
  perform public.notificar(array(select unnest(public.receptores()) except select me.id), '🔄 Consulta liberada — tomala',
    public.titulo_lead(p_lead), '/#lead/' || p_lead, 'lead-' || p_lead);
end $$;

create or replace function public.reasignar_lead(p_lead bigint, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads; dest public.perfiles;
begin
  if me.rol <> 'admin' then perform public.falla('Solo gerencia/administración.'); end if;
  select * into l from public.leads where id = p_lead;
  if l.id is null then perform public.falla('No existe ese lead.'); end if;
  if l.estado = 'cerrado' then perform public.falla('El lead está cerrado.'); end if;
  select * into dest from public.perfiles where id = p_user and activo;
  if dest.id is null then perform public.falla('Usuario inválido.'); end if;
  update public.leads set estado = 'asignado', asignado_a = dest.id, asignado_at = now(), motivo_asignacion = 'reasignado',
    vence_at = case when primera_respuesta_at is null then public.vencimiento(now(), public.minutos_respuesta()) end
  where id = p_lead;
  if l.primera_respuesta_at is not null then
    update public.contactos set titular_id = dest.id, ultima_actividad = now() where id = l.contacto_id;
  end if;
  perform public.log_evento(p_lead, 'reasignado', me.id, 'a ' || dest.nombre);
  perform public.notificar(array[dest.id], '📌 ' || me.nombre || ' te asignó una consulta', public.titulo_lead(p_lead), '/#lead/' || p_lead, 'lead-' || p_lead);
end $$;

create or replace function public.agregar_nota(p_lead bigint, p_texto text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); t text := btrim(coalesce(p_texto, ''));
begin
  if t = '' then perform public.falla('La nota está vacía.'); end if;
  perform public.exigir_ver(me.id, p_lead);
  insert into public.mensajes(lead_id, direccion, user_id, tipo, cuerpo) values (p_lead, 'nota', me.id, 'text', left(t, 4000));
end $$;

create or replace function public.actualizar_lead(p_lead bigint, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads; prod public.catalogo; campo text;
begin
  l := public.exigir_ver(me.id, p_lead);
  if me.rol <> 'admin' and l.asignado_a is distinct from me.id then perform public.falla('Tomá el lead primero.'); end if;
  if p ? 'etapa' then
    if not public.etapas() ? (p->>'etapa') then perform public.falla('Etapa inválida.'); end if;
    update public.leads set etapa = p->>'etapa' where id = p_lead;
    perform public.log_evento(p_lead, 'etapa', me.id, p->>'etapa');
  end if;
  if p ? 'producto_id' then
    if nullif(p->>'producto_id', '') is not null then
      select * into prod from public.catalogo where id = (p->>'producto_id')::int;
      if prod.id is null then perform public.falla('Producto inválido.'); end if;
    end if;
    update public.leads set producto_id = prod.id where id = p_lead;
    perform public.log_evento(p_lead, 'producto', me.id, coalesce(prod.nombre, '—'));
  end if;
  if p ? 'origen' then
    if not public.origenes_todos() ? (p->>'origen') then perform public.falla('Origen inválido.'); end if;
    update public.leads set origen = p->>'origen' where id = p_lead;
  end if;
  foreach campo in array array['nombre', 'localidad', 'provincia'] loop
    if p ? campo then
      execute format('update public.contactos set %I = $1 where id = $2', campo)
        using nullif(left(btrim(p->>campo), 120), ''), l.contacto_id;
    end if;
  end loop;
  if l.asignado_a is not null then
    update public.contactos set ultima_actividad = now() where id = l.contacto_id and titular_id = l.asignado_a;
  end if;
end $$;

create or replace function public.cerrar_lead(p_lead bigint, p_resultado text, p_monto numeric default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads;
begin
  l := public.exigir_ver(me.id, p_lead);
  if l.estado = 'cerrado' then perform public.falla('Ya está cerrado.'); end if;
  if me.rol <> 'admin' and l.asignado_a is distinct from me.id then perform public.falla('Tomá el lead primero.'); end if;
  if p_resultado not in ('vendido', 'perdido') then perform public.falla('Resultado inválido.'); end if;
  if p_resultado = 'vendido' and coalesce(p_monto, 0) <= 0 then perform public.falla('Indicá el monto de la venta en USD.'); end if;
  update public.leads set estado = 'cerrado', resultado = p_resultado,
    monto_usd = case when p_resultado = 'vendido' then p_monto end, cerrado_at = now(), vence_at = null, no_leidos = 0
  where id = p_lead;
  if p_resultado = 'vendido' then
    update public.contactos set vendido = true, ultima_actividad = now() where id = l.contacto_id;
    perform public.notificar(array(select unnest(public.admins()) except select me.id), '🎉 Venta de ' || me.nombre,
      public.titulo_lead(p_lead) || ' — USD ' || to_char(p_monto, 'FM999G999G999'), '/#lead/' || p_lead, 'venta-' || p_lead);
  end if;
  perform public.log_evento(p_lead, p_resultado, me.id, case when p_resultado = 'vendido' then 'USD ' || p_monto end);
end $$;

create or replace function public.reabrir_lead(p_lead bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads; otro bigint;
begin
  l := public.exigir_ver(me.id, p_lead);
  if l.estado <> 'cerrado' then perform public.falla('No está cerrado.'); end if;
  if me.rol <> 'admin' and l.asignado_a is distinct from me.id then perform public.falla('No es tuyo.'); end if;
  select id into otro from public.leads where contacto_id = l.contacto_id and estado <> 'cerrado';
  if otro is not null then perform public.falla('Ese cliente ya tiene otro lead abierto (#' || otro || ').'); end if;
  update public.leads set estado = case when asignado_a is null then 'pendiente' else 'asignado' end,
    resultado = null, monto_usd = null, cerrado_at = null where id = p_lead;
  perform public.log_evento(p_lead, 'reabierto', me.id);
end $$;

-- Envío: la Edge Function valida el JWT, llama a preparar_envio, envía por la API de Meta y registra con registrar_salida
create or replace function public.preparar_envio(p_lead bigint, p_user uuid, p_plantilla boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.leads; c public.contactos;
begin
  l := public.exigir_ver(p_user, p_lead);
  if l.estado = 'cerrado' then perform public.falla('El lead está cerrado. Si el cliente vuelve a escribir se abre uno nuevo.'); end if;
  if p_plantilla then
    if not public.es_admin_id(p_user) and l.asignado_a is distinct from p_user then perform public.falla('Tomá el lead primero.'); end if;
  else
    if l.ultimo_in_at is null or l.ultimo_in_at < now() - interval '24 hours' then
      perform public.falla('Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada.');
    end if;
    if l.estado = 'pendiente' then l := public.tomar_lead_de(p_lead, p_user); end if;  -- el primero que contesta se lo queda
  end if;
  select * into c from public.contactos where id = l.contacto_id;
  return jsonb_build_object('wa_id', c.wa_id, 'nombre', c.nombre, 'plantilla', public.ajuste('plantilla'));
end $$;

create or replace function public.registrar_salida(p_lead bigint, p_user uuid, p_texto text, p_wa_msg_id text, p_estado text, p_tipo text default 'text')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.leads; primera boolean;
begin
  select * into l from public.leads where id = p_lead for update;
  primera := l.primera_respuesta_at is null;
  insert into public.mensajes(lead_id, direccion, user_id, tipo, cuerpo, wa_msg_id, estado)
  values (p_lead, 'out', p_user, p_tipo, p_texto, p_wa_msg_id, p_estado);
  if p_tipo = 'auto' then return; end if;  -- la bienvenida automática no cuenta como respuesta
  update public.leads set ultimo_out_at = now(), no_leidos = 0,
    primera_respuesta_at = coalesce(primera_respuesta_at, now()),
    primera_respuesta_por = coalesce(primera_respuesta_por, p_user),
    vence_at = null
  where id = p_lead returning * into l;
  if primera then
    perform public.log_evento(p_lead, 'primera_respuesta', p_user,
      round(extract(epoch from (now() - coalesce(l.asignado_at, l.created_at))) / 60)::text);
  end if;
  if l.asignado_a is not null then
    update public.contactos set titular_id = l.asignado_a, ultima_actividad = now() where id = l.contacto_id;
  end if;
end $$;

-- Marca como leído si quien abre es el vendedor asignado; devuelve el último wa_msg_id para el tilde azul
create or replace function public.marcar_visto(p_lead bigint, p_user uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.leads; ult text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or l.no_leidos = 0 or l.estado <> 'asignado' or l.asignado_a is distinct from p_user then return null; end if;
  update public.leads set no_leidos = 0 where id = p_lead;
  select wa_msg_id into ult from public.mensajes where lead_id = p_lead and direccion = 'in' and wa_msg_id is not null order by id desc limit 1;
  return ult;
end $$;

-- ---------------------------------------------------------------------
-- Reloj: lo ejecuta pg_cron cada 30 segundos
-- ---------------------------------------------------------------------
create or replace function public.tick(p_ahora timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  minutos int := public.minutos_respuesta(); l public.leads; prev public.perfiles; n_lib int := 0; n_al int := 0;
begin
  for l in select * from public.leads where estado = 'asignado' and primera_respuesta_at is null
           and vence_at is not null and vence_at <= p_ahora for update skip locked loop
    select * into prev from public.perfiles where id = l.asignado_a;
    update public.leads set estado = 'pendiente', asignado_a = null, asignado_at = null, motivo_asignacion = null,
      vence_at = public.vencimiento(p_ahora, minutos), alerta_pool_enviada = false where id = l.id;
    perform public.log_evento(l.id, 'liberado_timeout', prev.id, coalesce(prev.nombre, '?') || ' no respondió en ' || minutos || ' min');
    perform public.notificar(array(select unnest(public.receptores()) except select prev.id),
      '⏰ Sin respuesta de ' || coalesce(prev.nombre, 'vendedor') || ' — tomala', public.titulo_lead(l.id), '/#lead/' || l.id, 'lead-' || l.id);
    perform public.notificar(public.admins(), '⏰ ' || coalesce(prev.nombre, 'Un vendedor') || ' no respondió en ' || minutos || ' min',
      public.titulo_lead(l.id) || ' volvió a la bolsa.', '/#lead/' || l.id, 'alerta-' || l.id);
    n_lib := n_lib + 1;
  end loop;

  for l in select * from public.leads where estado = 'pendiente' and not alerta_pool_enviada
           and vence_at is not null and vence_at <= p_ahora for update skip locked loop
    update public.leads set alerta_pool_enviada = true where id = l.id;
    perform public.log_evento(l.id, 'alerta_gerencia', null, 'Nadie la tomó en ' || minutos || ' min');
    perform public.notificar(public.admins(), '🚨 Consulta sin atender hace ' || minutos || ' min', public.titulo_lead(l.id), '/#lead/' || l.id, 'alerta-' || l.id);
    n_al := n_al + 1;
  end loop;
  return jsonb_build_object('liberados', n_lib, 'alertas', n_al);
end $$;

-- ---------------------------------------------------------------------
-- Lecturas para el panel
-- ---------------------------------------------------------------------
create or replace function public.fila_lead(l public.leads) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', l.id, 'estado', l.estado, 'etapa', l.etapa, 'resultado', l.resultado, 'monto_usd', l.monto_usd,
    'origen', l.origen, 'motivo_asignacion', l.motivo_asignacion, 'asignado_a', l.asignado_a,
    'vence_at', public.ms(l.vence_at), 'created_at', public.ms(l.created_at), 'ultimo_in_at', public.ms(l.ultimo_in_at),
    'ultimo_out_at', public.ms(l.ultimo_out_at), 'no_leidos', l.no_leidos, 'primera_respuesta_at', public.ms(l.primera_respuesta_at),
    'nombre', c.nombre, 'wa_id', c.wa_id, 'telefono', c.telefono,
    'producto', p.nombre, 'producto_codigo', p.codigo, 'producto_id', l.producto_id, 'asignado_nombre', u.nombre,
    'ultimo_texto', m.cuerpo, 'ultimo_tipo', m.tipo, 'ultimo_dir', m.direccion)
  from public.contactos c
  left join public.catalogo p on p.id = l.producto_id
  left join public.perfiles u on u.id = l.asignado_a
  left join lateral (select cuerpo, tipo, direccion from public.mensajes x where x.lead_id = l.id and x.direccion <> 'nota'
                     order by x.created_at desc, x.id desc limit 1) m on true
  where c.id = l.contacto_id
$$;

create or replace function public.listar_leads(p_vista text default 'pool', p_q text default '') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); q text := nullif(btrim(coalesce(p_q, '')), ''); filas jsonb;
begin
  if p_vista not in ('pool', 'mios', 'todos', 'cerrados') then perform public.falla('Vista inválida.'); end if;
  if p_vista = 'todos' and me.rol <> 'admin' then perform public.falla('Solo gerencia.'); end if;
  select coalesce(jsonb_agg(public.fila_lead(x) order by
           case when p_vista = 'cerrados' then x.cerrado_at else coalesce(x.ultimo_in_at, x.created_at) end desc), '[]')
  into filas
  from (
    select l.* from public.leads l
    join public.contactos c on c.id = l.contacto_id
    left join public.catalogo p on p.id = l.producto_id
    where case p_vista
            when 'pool' then l.estado = 'pendiente'
            when 'mios' then l.estado = 'asignado' and l.asignado_a = me.id
            when 'todos' then l.estado <> 'cerrado'
            else l.estado = 'cerrado' and (me.rol = 'admin' or l.asignado_a = me.id) end
      and (q is null or c.nombre ilike '%' || q || '%' or c.telefono like '%' || q || '%' or p.nombre ilike '%' || q || '%')
    order by case when p_vista = 'cerrados' then l.cerrado_at else coalesce(l.ultimo_in_at, l.created_at) end desc
    limit 300
  ) x;
  return jsonb_build_object(
    'leads', filas,
    'counts', jsonb_build_object(
      'pool', (select count(*) from public.leads where estado = 'pendiente'),
      'mios', (select count(*) from public.leads where estado = 'asignado' and asignado_a = me.id),
      'mios_no_leidos', (select count(*) from public.leads where estado = 'asignado' and asignado_a = me.id and no_leidos > 0),
      'todos', case when me.rol = 'admin' then (select count(*) from public.leads where estado <> 'cerrado') end),
    'ahora', public.ms(now()));
end $$;

create or replace function public.ver_lead(p_lead bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); l public.leads; c jsonb; hist jsonb := '[]'; visto boolean;
begin
  l := public.exigir_ver(me.id, p_lead);
  visto := l.no_leidos > 0 and l.estado = 'asignado' and l.asignado_a = me.id;
  select to_jsonb(x) || jsonb_build_object('titular_nombre', u.nombre, 'created_at', public.ms(x.created_at),
           'ultima_actividad', public.ms(x.ultima_actividad),
           'telefono_fmt', case when length(x.telefono) = 10
             then substr(x.telefono, 1, 3) || ' ' || substr(x.telefono, 4, 3) || '-' || substr(x.telefono, 7) else x.telefono end)
  into c from public.contactos x left join public.perfiles u on u.id = x.titular_id where x.id = l.contacto_id;
  if me.rol = 'admin' or l.asignado_a = me.id then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'created_at', public.ms(o.created_at), 'estado', o.estado,
             'resultado', o.resultado, 'monto_usd', o.monto_usd, 'producto', p.nombre, 'vendedor', u.nombre) order by o.id desc), '[]')
    into hist from public.leads o left join public.catalogo p on p.id = o.producto_id left join public.perfiles u on u.id = o.asignado_a
    where o.contacto_id = l.contacto_id and o.id <> l.id;
  end if;
  return jsonb_build_object(
    'lead', public.fila_lead(l) || jsonb_build_object('referral', l.referral, 'primera_respuesta_por', l.primera_respuesta_por),
    'contacto', c,
    'mensajes', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'direccion', m.direccion, 'tipo', m.tipo, 'cuerpo', m.cuerpo,
                   'media_id', m.media_id, 'estado', m.estado, 'error', m.error, 'created_at', public.ms(m.created_at), 'autor', u.nombre)
                   order by m.created_at, m.id), '[]')
                 from public.mensajes m left join public.perfiles u on u.id = m.user_id where m.lead_id = l.id),
    'eventos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', e.tipo, 'detalle', e.detalle, 'created_at', public.ms(e.created_at),
                   'usuario', u.nombre) order by e.id), '[]')
                from public.eventos e left join public.perfiles u on u.id = e.user_id where e.lead_id = l.id),
    'historial', hist,
    'ahora', public.ms(now()),
    'ventana_abierta', l.ultimo_in_at is not null and l.ultimo_in_at > now() - interval '24 hours',
    'marcar_leido', visto);
end $$;

create or replace function public.mi_config() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo();
begin
  return jsonb_build_object(
    'user', jsonb_build_object('id', me.id, 'nombre', me.nombre, 'usuario', me.usuario, 'rol', me.rol, 'recibe_leads', me.recibe_leads),
    'origenes', public.origenes(), 'origenesTodos', public.origenes_todos(), 'etapas', public.etapas(),
    'minutos', public.minutos_respuesta(),
    'usuarios', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'rol', rol, 'recibe_leads', recibe_leads)
                   order by rol desc, nombre), '[]') from public.perfiles where activo),
    'plantilla', coalesce(public.ajuste('plantilla')->>'nombre', '') <> '');
end $$;

create or replace function public.guardar_suscripcion(p_sub jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo();
begin
  if coalesce(p_sub->>'endpoint', '') !~ '^https://' then perform public.falla('Suscripción inválida.'); end if;
  insert into public.push_subs(user_id, endpoint, data) values (me.id, p_sub->>'endpoint', p_sub)
  on conflict (endpoint) do update set user_id = excluded.user_id, data = excluded.data;
end $$;

-- ---------------------------------------------------------------------
-- Gerencia: métricas, exportación, usuarios y ajustes
-- ---------------------------------------------------------------------
create or replace function public.rango_local(p_desde date, p_hasta date, out d timestamptz, out h timestamptz)
language plpgsql stable as $$
declare tz text := coalesce(public.ajuste('zona_horaria') #>> '{}', 'America/Argentina/Buenos_Aires');
begin
  d := coalesce(p_desde, date_trunc('month', now() at time zone tz)::date)::timestamp at time zone tz;
  h := (coalesce(p_hasta, (now() at time zone tz)::date) + 1)::timestamp at time zone tz;
  if h <= d then perform public.falla('Rango de fechas inválido.'); end if;
end $$;

create or replace function public.metricas(p_desde date default null, p_hasta date default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); d timestamptz; h timestamptz;
  tz text := coalesce(public.ajuste('zona_horaria') #>> '{}', 'America/Argentina/Buenos_Aires'); res jsonb;
begin
  if me.rol <> 'admin' then perform public.falla('Solo gerencia/administración.'); end if;
  select r.d, r.h into d, h from public.rango_local(p_desde, p_hasta) r;

  create temp table _l on commit drop as
    select l.*, p.nombre as producto, p.categoria,
           extract(epoch from (l.primera_respuesta_at - l.created_at)) / 60 as resp_min
    from public.leads l left join public.catalogo p on p.id = l.producto_id
    where l.created_at >= d and l.created_at < h;
  create temp table _e on commit drop as
    select tipo, user_id, lead_id from public.eventos
    where created_at >= d and created_at < h and tipo in ('liberado_timeout', 'alerta_gerencia', 'tomado');

  select jsonb_build_object(
    'desde', public.ms(d), 'hasta', public.ms(h),
    'totales', (select jsonb_build_object(
        'leads', count(*),
        'atendidos', count(*) filter (where primera_respuesta_at is not null),
        'sin_atender_ahora', count(*) filter (where estado = 'pendiente'),
        'vendidos', count(*) filter (where resultado = 'vendido'),
        'monto_usd', coalesce(sum(monto_usd) filter (where resultado = 'vendido'), 0),
        'perdidos', count(*) filter (where resultado = 'perdido'),
        'conversion', case when count(*) > 0 then (count(*) filter (where resultado = 'vendido'))::numeric / count(*) else 0 end,
        'respuesta_mediana_min', round((percentile_cont(0.5) within group (order by resp_min))::numeric, 1),
        'respuesta_promedio_min', round(avg(resp_min)::numeric, 1),
        'alertas_gerencia', (select count(*) from _e where tipo = 'alerta_gerencia'),
        'timeouts', (select count(*) from _e where tipo = 'liberado_timeout')) from _l),
    'porVendedor', (select coalesce(jsonb_agg(v order by v->>'nombre'), '[]') from (
        select jsonb_build_object('id', u.id, 'nombre', u.nombre, 'rol', u.rol,
          'leads', (select count(*) from _l where asignado_a = u.id),
          'tomados', (select count(*) from _e where tipo = 'tomado' and user_id = u.id),
          'respondidos', (select count(*) from _l where primera_respuesta_por = u.id),
          'respuesta_mediana_min', (select round((percentile_cont(0.5) within group (order by
              extract(epoch from (primera_respuesta_at - case when asignado_at is not null and asignado_at <= primera_respuesta_at then asignado_at else created_at end)) / 60))::numeric, 1)
              from _l where primera_respuesta_por = u.id),
          'timeouts', (select count(*) from _e where tipo = 'liberado_timeout' and user_id = u.id),
          'abiertos', (select count(*) from _l where asignado_a = u.id and estado = 'asignado'),
          'vendidos', (select count(*) from _l where asignado_a = u.id and resultado = 'vendido'),
          'monto_usd', (select coalesce(sum(monto_usd), 0) from _l where asignado_a = u.id and resultado = 'vendido'),
          'conversion', (select case when count(*) > 0 then (count(*) filter (where resultado = 'vendido'))::numeric / count(*) else 0 end
                         from _l where asignado_a = u.id)) v
        from public.perfiles u
        where u.rol = 'vendedor' and u.activo or exists (select 1 from _l where asignado_a = u.id or primera_respuesta_por = u.id)) s),
    'porOrigen', (select coalesce(jsonb_agg(jsonb_build_object('nombre', k, 'leads', n, 'vendidos', v, 'monto_usd', m) order by n desc), '[]')
        from (select coalesce(origen, 'Sin identificar') k, count(*) n, count(*) filter (where resultado = 'vendido') v,
                     coalesce(sum(monto_usd) filter (where resultado = 'vendido'), 0) m from _l group by 1) s),
    'porProducto', (select coalesce(jsonb_agg(jsonb_build_object('nombre', k, 'leads', n, 'vendidos', v, 'monto_usd', m) order by n desc), '[]')
        from (select coalesce(producto, 'Sin identificar') k, count(*) n, count(*) filter (where resultado = 'vendido') v,
                     coalesce(sum(monto_usd) filter (where resultado = 'vendido'), 0) m from _l group by 1 order by 2 desc limit 20) s),
    'porDia', (select coalesce(jsonb_agg(jsonb_build_object('fecha', to_char(dia, 'YYYY-MM-DD'), 'leads',
                 (select count(*) from _l where (created_at at time zone tz)::date = dia)) order by dia), '[]')
        from generate_series((d at time zone tz)::date, ((h at time zone tz)::date - 1), interval '1 day') g(dia))
  ) into res;
  return res;
end $$;

create or replace function public.exportar_leads(p_desde date default null, p_hasta date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); d timestamptz; h timestamptz;
  tz text := coalesce(public.ajuste('zona_horaria') #>> '{}', 'America/Argentina/Buenos_Aires');
begin
  if me.rol <> 'admin' then perform public.falla('Solo gerencia/administración.'); end if;
  select r.d, r.h into d, h from public.rango_local(p_desde, p_hasta) r;
  return (select coalesce(jsonb_agg(jsonb_build_array(
      l.id, to_char(l.created_at at time zone tz, 'DD/MM/YYYY'), to_char(l.created_at at time zone tz, 'HH24:MI'),
      u.nombre, c.nombre, c.telefono, c.localidad, c.provincia, p.categoria, p.nombre, l.origen, l.etapa, l.estado, r.nombre,
      round(extract(epoch from (l.primera_respuesta_at - l.created_at)) / 60), l.resultado, l.monto_usd,
      to_char(l.cerrado_at at time zone tz, 'DD/MM/YYYY')) order by l.id), '[]')
    from public.leads l join public.contactos c on c.id = l.contacto_id
    left join public.perfiles u on u.id = l.asignado_a left join public.perfiles r on r.id = l.primera_respuesta_por
    left join public.catalogo p on p.id = l.producto_id
    where l.created_at >= d and l.created_at < h);
end $$;

create or replace function public.admin_usuarios() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.es_admin() then perform public.falla('Solo gerencia/administración.'); end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'usuario', usuario, 'rol', rol,
            'recibe_leads', recibe_leads, 'activo', activo) order by activo desc, rol desc, nombre), '[]') from public.perfiles);
end $$;

create or replace function public.admin_actualizar_usuario(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.perfiles := public.yo(); u public.perfiles; l record;
begin
  if me.rol <> 'admin' then perform public.falla('Solo gerencia/administración.'); end if;
  select * into u from public.perfiles where id = p_id;
  if u.id is null then perform public.falla('No existe.'); end if;
  if p_id = me.id and ((p ? 'activo' and not (p->>'activo')::boolean) or p->>'rol' = 'vendedor') then
    perform public.falla('No podés desactivarte ni quitarte el rol a vos mismo.');
  end if;
  update public.perfiles set
    nombre = coalesce(nullif(left(btrim(p->>'nombre'), 40), ''), nombre),
    rol = case when p ? 'rol' then case when p->>'rol' = 'admin' then 'admin' else 'vendedor' end else rol end,
    recibe_leads = coalesce((p->>'recibe_leads')::boolean, recibe_leads),
    activo = coalesce((p->>'activo')::boolean, activo)
  where id = p_id;
  if p ? 'activo' and not (p->>'activo')::boolean then
    for l in select id from public.leads where estado = 'asignado' and asignado_a = p_id loop
      update public.leads set estado = 'pendiente', asignado_a = null, asignado_at = null, vence_at = now() where id = l.id;
      perform public.log_evento(l.id, 'liberado', me.id, u.nombre || ' fue desactivado');
    end loop;
  end if;
end $$;

create or replace function public.admin_ajustes() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.es_admin() then perform public.falla('Solo gerencia/administración.'); end if;
  return (select jsonb_object_agg(clave, valor) from public.ajustes);
end $$;

create or replace function public.guardar_ajustes(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare n numeric; hr jsonb; z jsonb; lista jsonb := '[]';
begin
  if not public.es_admin() then perform public.falla('Solo gerencia/administración.'); end if;
  if p ? 'minutos_respuesta' then
    n := (p->>'minutos_respuesta')::numeric;
    if n is null or n < 1 or n > 240 then perform public.falla('Minutos de respuesta: entre 1 y 240.'); end if;
    update public.ajustes set valor = to_jsonb(round(n)::int) where clave = 'minutos_respuesta';
  end if;
  if p ? 'dias_titular' then
    n := (p->>'dias_titular')::numeric;
    if n is null or n < 1 or n > 365 then perform public.falla('Días de titularidad: entre 1 y 365.'); end if;
    update public.ajustes set valor = to_jsonb(round(n)::int) where clave = 'dias_titular';
  end if;
  if p ? 'horario' then
    hr := p->'horario';
    if coalesce(hr->>'desde', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' or coalesce(hr->>'hasta', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
      perform public.falla('Horario inválido (HH:MM).');
    end if;
    update public.ajustes set valor = jsonb_build_object('activo', coalesce((hr->>'activo')::boolean, false),
      'dias', (select coalesce(jsonb_agg(distinct (x)::int order by (x)::int), '[]') from jsonb_array_elements_text(coalesce(hr->'dias', '[]')) x where x ~ '^[0-6]$'),
      'desde', hr->>'desde', 'hasta', hr->>'hasta') where clave = 'horario';
  end if;
  if p ? 'zonas' then
    for z in select * from jsonb_array_elements(coalesce(p->'zonas'->'lista', '[]')) limit 20 loop
      if coalesce(btrim(z->>'nombre'), '') <> '' then
        lista := lista || jsonb_build_array(jsonb_build_object(
          'nombre', left(btrim(z->>'nombre'), 40),
          'prefijos', (select coalesce(jsonb_agg(x), '[]') from (
              select regexp_replace(t, '\D', '', 'g') x from regexp_split_to_table(
                case jsonb_typeof(z->'prefijos') when 'array' then (select string_agg(v, ',') from jsonb_array_elements_text(z->'prefijos') v)
                     else coalesce(z->>'prefijos', '') end, '[,\s]+') t) s where x <> ''),
          'titular', left(coalesce(z->>'titular', ''), 40)));
      end if;
    end loop;
    update public.ajustes set valor = jsonb_build_object('activo', coalesce((p->'zonas'->>'activo')::boolean, false), 'lista', lista)
    where clave = 'zonas';
  end if;
  if p ? 'bienvenida' then
    update public.ajustes set valor = jsonb_build_object('activo', coalesce((p->'bienvenida'->>'activo')::boolean, false),
      'texto', left(coalesce(p->'bienvenida'->>'texto', ''), 1000)) where clave = 'bienvenida';
  end if;
  if p ? 'plantilla' then
    update public.ajustes set valor = jsonb_build_object(
      'nombre', regexp_replace(lower(coalesce(p->'plantilla'->>'nombre', '')), '[^a-z0-9_]', '', 'g'),
      'idioma', coalesce(nullif(left(p->'plantilla'->>'idioma', 10), ''), 'es_AR'),
      'usa_nombre', coalesce((p->'plantilla'->>'usa_nombre')::boolean, false),
      'texto', left(coalesce(p->'plantilla'->>'texto', ''), 500)) where clave = 'plantilla';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Seguridad: RLS + permisos
-- ---------------------------------------------------------------------
alter table public.perfiles enable row level security;
alter table public.catalogo enable row level security;
alter table public.contactos enable row level security;
alter table public.leads enable row level security;
alter table public.mensajes enable row level security;
alter table public.eventos enable row level security;
alter table public.push_subs enable row level security;
alter table public.ajustes enable row level security;
alter table public.notificaciones enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
-- Las Edge Functions usan service_role: permisos explícitos (no depender de los valores por defecto)
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Lecturas directas mínimas (el resto pasa por funciones):
-- leads y mensajes para que Supabase Realtime avise los cambios respetando quién puede ver qué.
grant select on public.leads, public.mensajes, public.catalogo, public.perfiles to authenticated;

drop policy if exists leads_ver on public.leads;
create policy leads_ver on public.leads for select to authenticated
  using (public.puede_ver(auth.uid(), leads));

drop policy if exists mensajes_ver on public.mensajes;
create policy mensajes_ver on public.mensajes for select to authenticated
  using (exists (select 1 from public.leads l where l.id = mensajes.lead_id and public.puede_ver(auth.uid(), l)));

drop policy if exists catalogo_ver on public.catalogo;
create policy catalogo_ver on public.catalogo for select to authenticated using (activo);

drop policy if exists perfiles_ver on public.perfiles;
create policy perfiles_ver on public.perfiles for select to authenticated using (activo);

-- Funciones: por defecto nadie; después se habilita lo que corresponde a cada rol
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- Lo que puede llamar un usuario con sesión iniciada desde el panel
grant execute on function
  public.listar_leads(text, text), public.ver_lead(bigint), public.tomar_lead(bigint), public.liberar_lead(bigint),
  public.reasignar_lead(bigint, uuid), public.agregar_nota(bigint, text), public.actualizar_lead(bigint, jsonb),
  public.cerrar_lead(bigint, text, numeric), public.reabrir_lead(bigint), public.mi_config(), public.guardar_suscripcion(jsonb),
  public.metricas(date, date), public.exportar_leads(date, date), public.admin_usuarios(), public.admin_actualizar_usuario(uuid, jsonb),
  public.admin_ajustes(), public.guardar_ajustes(jsonb),
  -- usadas por las políticas RLS
  public.puede_ver(uuid, public.leads), public.es_admin()
to authenticated;

-- ---------------------------------------------------------------------
-- Tiempo real (Supabase Realtime)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.leads'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.mensajes'; exception when duplicate_object then null; end;
  end if;
end $$;
