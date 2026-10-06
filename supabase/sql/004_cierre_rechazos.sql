-- 6-oct (Jorge): links de viajes anteriores
-- pod_at: cuándo quedó el POD; el link se cierra 3 días después (pod-api).
-- pod_rechazo: intentos rechazados (link viejo, camión cerrado); NetSuite avisa a logística.
alter table pod_camion add column if not exists pod_at timestamptz;

update pod_camion c set pod_at = coalesce(
  (select max(e.created_at) from pod_evento e where e.entrega_id = c.entrega_id and e.accion = 'entrega'), c.updated_at)
where c.pod and c.pod_at is null;

create or replace function pod_camion_pod_at() returns trigger language plpgsql as $$
begin
  if new.pod and new.pod_at is null then
    new.pod_at := case when tg_op = 'UPDATE' then coalesce(old.pod_at, now()) else now() end;
  end if;
  return new;
end $$;
drop trigger if exists trg_pod_camion_pod_at on pod_camion;
create trigger trg_pod_camion_pod_at before insert or update on pod_camion for each row execute function pod_camion_pod_at();

create table if not exists pod_rechazo (
  id bigserial primary key,
  token text, entrega_id integer, folio text, accion text, motivo text,
  tipo text, nombre text, nota text, hora_cel text,
  created_at timestamptz not null default now(),
  avisado_at timestamptz
);
alter table pod_rechazo enable row level security;
