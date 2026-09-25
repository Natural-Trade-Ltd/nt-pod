-- NT Carrier Portal · Portal del transportista (POD por QR) · 24-sep-2026
-- Tablas privadas: solo la función pod-api (service role) las usa. RLS activo y sin políticas = nadie más lee/escribe.
create table if not exists public.pod_camion (
  token         text primary key,
  entrega_id    integer not null,
  folio         text,
  so            text,
  cliente       text,
  destino       text,
  origen        text,
  transportista text,
  unidad        text,
  carga         text,
  status        text,
  pod           boolean not null default false,
  llegada       timestamptz,
  cerrado       boolean not null default false,
  updated_at    timestamptz not null default now()
);
create table if not exists public.pod_evento (
  id           bigint generated always as identity primary key,
  token        text not null references public.pod_camion(token),
  entrega_id   integer,
  accion       text not null check (accion in ('llegada','entrega','incidente')),
  tipo         text,
  nombre       text,
  nota         text,
  lat          double precision,
  lng          double precision,
  prec         double precision,
  hora_cel     text,
  fotos        text[] not null default '{}',
  created_at   timestamptz not null default now(),
  procesado_at timestamptz,
  intentos     integer not null default 0,
  error        text
);
create index if not exists pod_evento_pend on public.pod_evento (procesado_at) where procesado_at is null;
alter table public.pod_camion enable row level security;
alter table public.pod_evento enable row level security;
revoke all on public.pod_camion from anon, authenticated;
revoke all on public.pod_evento from anon, authenticated;
insert into storage.buckets (id, name, public) values ('pod', 'pod', false) on conflict (id) do nothing;
