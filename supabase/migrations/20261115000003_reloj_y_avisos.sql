-- =====================================================================
-- Reloj (cada 30 s) y envío de avisos push. Requiere pg_cron, pg_net y Vault (Supabase).
-- Los secretos se cargan aparte (ver GUIA.md): nautica_push_url y nautica_push_secret.
-- =====================================================================
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Cada aviso nuevo se manda al instante a la Edge Function "push"
create or replace function public.despachar_notificacion() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_secreto text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'nautica_push_url';
  select decrypted_secret into v_secreto from vault.decrypted_secrets where name = 'nautica_push_secret';
  if v_url is null or v_secreto is null then return new; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-nautica-secret', v_secreto),
    timeout_milliseconds := 5000);
  return new;
end $$;
revoke all on function public.despachar_notificacion() from public, anon, authenticated;

drop trigger if exists notificaciones_despachar on public.notificaciones;
create trigger notificaciones_despachar after insert on public.notificaciones
  for each row execute function public.despachar_notificacion();

-- Reloj de respuesta: libera consultas vencidas y alerta a gerencia
select cron.unschedule('nautica-reloj') where exists (select 1 from cron.job where jobname = 'nautica-reloj');
select cron.schedule('nautica-reloj', '30 seconds', 'select public.tick()');

-- Limpieza semanal de avisos ya enviados (más de 30 días)
select cron.unschedule('nautica-limpieza') where exists (select 1 from cron.job where jobname = 'nautica-limpieza');
select cron.schedule('nautica-limpieza', '17 4 * * 0', $$delete from public.notificaciones where created_at < now() - interval '30 days'$$);
