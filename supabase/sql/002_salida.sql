-- Evento «salida» (el chofer ya cargó y salió) para el estatus automático del camión (27-sep-2026)
alter table public.pod_evento drop constraint if exists pod_evento_accion_check;
alter table public.pod_evento add constraint pod_evento_accion_check check (accion in ('salida','llegada','entrega','incidente'));
