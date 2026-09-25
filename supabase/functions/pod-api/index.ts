// NT Carrier Portal · pod-api (Supabase Edge Function, verify_jwt = false) · 24-sep-2026
// Público (lo llama la página de GitHub Pages con el token del QR):
//   GET  ?t=<token>                               → datos del camión para la página (sin precios)
//   POST {t, accion, fotos[], lat, lng, prec, nombre, nota, tipo, hora_cel}
//        accion = llegada | entrega | incidente    → guarda fotos (bucket privado «pod») y el evento
// Privado (lo llama NetSuite con el header x-pod-secret = POD_SECRET):
//   POST {op:'sync', camiones:[…]}                → alta/actualización de camiones (token, folio, cliente…)
//   POST {op:'pendientes', max}                   → eventos sin procesar con sus fotos en base64
//   POST {op:'procesado', id, error?}             → marca el evento como aplicado en NetSuite (o su error)
import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SECRET = Deno.env.get('POD_SECRET') || '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-pod-secret', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const tokenOk = (t: unknown) => typeof t === 'string' && t.length >= 24 && /^[A-Za-z0-9-]+$/.test(t);
const PUBLICO = 'folio, so, cliente, destino, origen, transportista, unidad, carga, status, pod, llegada, cerrado';

function b64ToBytes(b64: string) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u: Uint8Array) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode(...u.subarray(i, i + CH)); return btoa(s); }

async function registrar(b: Record<string, unknown>) {
  if (!tokenOk(b.t)) return json({ error: 'Código no válido. Escanea de nuevo el QR de la Carta Porte.' }, 400);
  const { data: c } = await db.from('pod_camion').select('token, entrega_id, status, cerrado').eq('token', b.t).maybeSingle();
  if (!c) return json({ error: 'Código no válido o vencido.' }, 404);
  if (c.cerrado) return json({ error: 'Este camión ya está cerrado. Si necesitas reportar algo, llama a logística.' }, 409);
  const accion = String(b.accion || '');
  if (!['llegada', 'entrega', 'incidente'].includes(accion)) return json({ error: 'Acción no válida.' }, 400);
  const fotos = (Array.isArray(b.fotos) ? b.fotos : []).slice(0, 10) as { base64?: string; tipo?: string }[];
  if (accion !== 'incidente' && !fotos.length) return json({ error: 'Toma la foto antes de enviar.' }, 400);
  const rutas: string[] = [];
  for (let i = 0; i < fotos.length; i++) {
    const f = fotos[i]; if (!f?.base64) continue;
    const bytes = b64ToBytes(f.base64);
    if (bytes.length > 4 * 1024 * 1024) return json({ error: 'Una foto pesa demasiado; vuelve a tomarla.' }, 413);
    const ruta = `${c.entrega_id}/${accion}_${Date.now()}_${i + 1}.jpg`;
    const { error } = await db.storage.from('pod').upload(ruta, bytes, { contentType: 'image/jpeg', upsert: false });
    if (error) return json({ error: 'No se pudo guardar la foto: ' + error.message }, 500);
    rutas.push(ruta);
  }
  const n = (x: unknown) => (typeof x === 'number' && isFinite(x) ? x : null);
  const { error: e2 } = await db.from('pod_evento').insert({ token: c.token, entrega_id: c.entrega_id, accion, tipo: String(b.tipo || '').slice(0, 80) || null,
    nombre: String(b.nombre || '').slice(0, 120) || null, nota: String(b.nota || '').slice(0, 2000) || null, lat: n(b.lat), lng: n(b.lng), prec: n(b.prec),
    hora_cel: String(b.hora_cel || '').slice(0, 60) || null, fotos: rutas });
  if (e2) return json({ error: 'No se pudo registrar: ' + e2.message }, 500);
  // vista inmediata para el operador (NetSuite confirma al sincronizar)
  if (accion === 'llegada') await db.from('pod_camion').update({ status: 'En destino', llegada: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('token', c.token);
  if (accion === 'entrega') await db.from('pod_camion').update({ status: 'POD recibido', pod: true, updated_at: new Date().toISOString() }).eq('token', c.token);
  return json({ ok: true, msg: accion === 'llegada' ? 'Llegada registrada. ¡Gracias!' : accion === 'entrega' ? 'Entrega registrada con POD. ¡Gracias!' : 'Incidente registrado. Logística será avisada.' });
}

async function privado(b: Record<string, unknown>) {
  if (b.op === 'sync') {
    const filas = (Array.isArray(b.camiones) ? b.camiones : []).filter((x: any) => tokenOk(x?.token) && x?.entrega_id)
      .map((x: any) => ({ token: x.token, entrega_id: Number(x.entrega_id), folio: x.folio ?? null, so: x.so ?? null, cliente: x.cliente ?? null, destino: x.destino ?? null,
        origen: x.origen ?? null, transportista: x.transportista ?? null, unidad: x.unidad ?? null, carga: x.carga ?? null, status: x.status ?? null,
        pod: !!x.pod, cerrado: !!x.cerrado, updated_at: new Date().toISOString() }));
    if (!filas.length) return json({ ok: true, n: 0 });
    const { error } = await db.from('pod_camion').upsert(filas, { onConflict: 'token' });
    return error ? json({ error: error.message }, 500) : json({ ok: true, n: filas.length });
  }
  if (b.op === 'pendientes') {
    const max = Math.min(Number(b.max) || 5, 10);
    const { data, error } = await db.from('pod_evento').select('*').is('procesado_at', null).lt('intentos', 5).order('id').limit(max);
    if (error) return json({ error: error.message }, 500);
    const out = [];
    for (const ev of data || []) {
      const fotos = [];
      for (const ruta of ev.fotos || []) {
        const { data: blob } = await db.storage.from('pod').download(ruta);
        if (blob) fotos.push({ ruta, base64: bytesToB64(new Uint8Array(await blob.arrayBuffer())) });
      }
      out.push({ ...ev, fotos });
    }
    return json({ ok: true, eventos: out });
  }
  if (b.op === 'procesado') {
    const id = Number(b.id); if (!id) return json({ error: 'Falta id' }, 400);
    const { data: ev } = await db.from('pod_evento').select('intentos').eq('id', id).maybeSingle();
    const upd = b.error ? { error: String(b.error).slice(0, 1000), intentos: (ev?.intentos || 0) + 1 } : { procesado_at: new Date().toISOString(), error: null };
    const { error } = await db.from('pod_evento').update(upd).eq('id', id);
    return error ? json({ error: error.message }, 500) : json({ ok: true });
  }
  return json({ error: 'op no válida' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') {
      const t = new URL(req.url).searchParams.get('t');
      if (!tokenOk(t)) return json({ error: 'Código no válido.' }, 400);
      const { data } = await db.from('pod_camion').select(PUBLICO).eq('token', t).maybeSingle();
      return data ? json({ ok: true, camion: data }) : json({ error: 'Código no válido o vencido.' }, 404);
    }
    const b = await req.json().catch(() => ({}));
    if (b && b.op) {
      if (!SECRET || req.headers.get('x-pod-secret') !== SECRET) return json({ error: 'no autorizado' }, 401);
      return await privado(b);
    }
    return await registrar(b);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
