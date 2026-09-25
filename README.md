# nt-pod

Portal del transportista (POD por QR de la Carta Porte) de Global Forest / Natural Trade.

- `index.html`: página pública (GitHub Pages) → `https://natural-trade-ltd.github.io/nt-pod/?t=<token>`
- `supabase/functions/pod-api`: función en Supabase (proyecto NT-Evento-Comite) que guarda llegadas, POD e incidentes.
- `supabase/sql/001_pod.sql`: tablas `pod_camion`, `pod_evento` y bucket privado `pod`.
- NetSuite sincroniza los camiones y aplica los eventos (proyecto nt-carrier-portal-sdf, `lib/nt_pod.js`).

La clave compartida `POD_SECRET` vive solo en Supabase (secrets) y en NetSuite; nunca en este repo.
