-- 9-oct-2026 (Jorge): Carta Porte del furgón con UN solo QR para varias entregas parciales.
-- El camión del QR (carga definida por el patio) es la entrega 1. Cada chofer que escanea y dice «Soy un camión nuevo» abre la
-- siguiente entrega parcial (2, 3, …) con sus propias salida, llegada, incidentes y POD. NetSuite crea el camión de cada parcial
-- al sincronizar. Cuando logística da el visto bueno de entrega completa, el QR ya no abre entregas nuevas y se ven «n de N».

-- multi: el QR admite varias entregas (carga definida por el patio, no traslado). multi_total: N al confirmar el 100 % (null = abierto).
alter table pod_camion add column if not exists multi boolean not null default false;
alter table pod_camion add column if not exists multi_total integer;

-- Entregas parciales 2..N (la 1 es la fila de pod_camion)
create table if not exists pod_parcial (
  id          bigserial primary key,
  token       text not null references pod_camion(token),
  n           integer not null,
  placas      text,
  chofer      text,
  carga_txt   text,
  status      text not null default 'En tránsito',
  llegada     timestamptz,
  pod         boolean not null default false,
  pod_at      timestamptz,
  created_at  timestamptz not null default now(),
  unique (token, n)
);
alter table pod_parcial enable row level security;
revoke all on pod_parcial from anon, authenticated;

-- Evento de una parcial: n de la entrega (1 = el camión del QR; null = camión normal). placas / carga_txt: los captura el chofer al abrir la parcial.
alter table pod_evento add column if not exists parcial_n integer;
alter table pod_evento add column if not exists placas text;
alter table pod_evento add column if not exists carga_txt text;
alter table pod_rechazo add column if not exists parcial_n integer;
