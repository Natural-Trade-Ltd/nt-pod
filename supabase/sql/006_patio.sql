-- NT Carrier Portal · Portal del PATIO (QR por furgón en el correo de «Instrucciones patio») · 8-nov-2026
-- Tablas APARTE de las del chofer (pod_*): no tocan nada del QR de los transportistas (decisión de Jorge 8-nov).
-- Privadas: solo la función patio-api (service role) las usa. RLS activo y sin políticas = nadie más lee/escribe.

-- Un furgón (rastreo terrestre) con su token. ficha = lo que ve el patio (sin precios): carro, ICPO, clientes, qué hacer, camiones.
create table if not exists public.patio_furgon (
  token       text primary key,
  lg_id       integer not null unique,          -- customrecord_nso_logistica (rastreo terrestre)
  icpo_id     integer not null,
  icpo        text,
  patio       text,
  carro       text,
  eta         date,
  dias_libres integer,
  ficha       jsonb not null default '{}'::jsonb,
  llegada     timestamptz,                      -- vista inmediata (NetSuite pone la Fecha patio al sincronizar)
  fotos_n     integer not null default 0,
  salidas     jsonb not null default '[]'::jsonb,   -- [{so, tipo, at}] para mostrar «✔ ya reportado»
  cerrado     boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists public.patio_evento (
  id           bigint generated always as identity primary key,
  token        text not null references public.patio_furgon(token),
  lg_id        integer,
  accion       text not null check (accion in ('llegada', 'fotos', 'entregamos', 'recogio')),
  fecha        timestamptz,                     -- la que capturó el patio (llegada / salida)
  so_id        integer,                         -- entregamos / recogio: de qué venta
  nombre       text,
  nota         text,
  hora_cel     text,
  fotos        text[] not null default '{}',
  created_at   timestamptz not null default now(),
  procesado_at timestamptz,
  intentos     integer not null default 0,
  error        text
);
create index if not exists patio_evento_pend on public.patio_evento (procesado_at) where procesado_at is null;

alter table public.patio_furgon enable row level security;
alter table public.patio_evento enable row level security;
revoke all on public.patio_furgon from anon, authenticated;
revoke all on public.patio_evento from anon, authenticated;

-- Fotos del patio en su propio bucket privado
insert into storage.buckets (id, name, public) values ('patio', 'patio', false) on conflict (id) do nothing;
