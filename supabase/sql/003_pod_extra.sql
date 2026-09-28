-- Fotos adicionales de la entrega (faltó una firma, hoja adicional, foto borrosa) — 28-sep-2026
alter table public.pod_evento drop constraint if exists pod_evento_accion_check;
alter table public.pod_evento add constraint pod_evento_accion_check check (accion in ('salida','llegada','entrega','pod_extra','incidente'));
