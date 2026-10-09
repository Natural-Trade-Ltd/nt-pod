// NT Carrier Portal · pod-api (Supabase Edge Function, verify_jwt = false) · 24-sep-2026
// Público (lo llama la página de GitHub Pages con el token del QR):
//   GET  ?t=<token>                               → datos del camión para la página (sin precios)
//   POST {t, accion, fotos[], lat, lng, prec, nombre, nota, tipo, hora_cel}
//        accion = salida | llegada | entrega | incidente    → guarda fotos (bucket privado «pod») y el evento
//   9-oct (Jorge) · furgón con un solo QR (multi = carga definida por el patio): {parcial: n | 'nuevo', placas, carga_txt}
//        'nuevo' (solo con salida) abre la siguiente entrega parcial (la 1 es el camión del QR); n sigue esa parcial.
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
const PUBLICO = 'folio, so, cliente, destino, origen, transportista, unidad, carga, status, pod, llegada, cerrado, pod_at, traslado, multi, multi_total';
// 6-oct (Jorge): el link de un camión se cierra 3 días después de su POD (los choferes guardan links de viajes anteriores)
const DIAS_CIERRE = 3;
const vencido = (c: { pod?: boolean; pod_at?: string | null; multi?: boolean; multi_total?: number | null }) =>
  !(c.multi && !c.multi_total) && !!c.pod && !!c.pod_at && Date.now() - Date.parse(c.pod_at) > DIAS_CIERRE * 86400000;   // furgón abierto: el QR sigue vivo
const RK = ['Borrador', 'Asignada', 'Confirmada', 'En tránsito', 'En destino', 'Entregada', 'POD recibido', 'Facturada', 'Cerrada'];
/** Entregas del furgón: la 1 es el camión del QR, luego las parciales. */
async function parcialesDe(c: Record<string, any>) {
  const { data } = await db.from('pod_parcial').select('n, placas, chofer, status, llegada, pod').eq('token', c.token).order('n');
  return [{ n: 1, placas: null, chofer: null, status: c.status, llegada: c.llegada, pod: !!c.pod }, ...(data || [])];
}
const MSG_VIEJO = 'Este link es de un viaje que ya se entregó. Si vas en un viaje nuevo, abre el link nuevo que te mandó logística o escanea el QR de la Carta Porte nueva. Si el problema es de este viaje, llama a logística.';

function b64ToBytes(b64: string) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u: Uint8Array) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode(...u.subarray(i, i + CH)); return btoa(s); }

async function registrar(b: Record<string, unknown>) {
  if (!tokenOk(b.t)) return json({ error: 'Código no válido. Escanea de nuevo el QR de la Carta Porte.' }, 400);
  const { data: c0 } = await db.from('pod_camion').select('token, entrega_id, folio, status, cerrado, pod, llegada, pod_at, traslado, multi, multi_total').eq('token', b.t).maybeSingle();
  if (!c0) return json({ error: 'Código no válido o vencido.' }, 404);
  const accion = String(b.accion || '');
  // Furgón (9-oct): la entrega que se registra. pn = 1 → el camión del QR (fila de pod_camion); pn ≥ 2 → pod_parcial
  let c: Record<string, any> = c0, pn: number | null = null, nuevaParcial = false;
  if (c0.multi && b.parcial != null && b.parcial !== '') {
    if (b.parcial === 'nuevo') {
      if (accion !== 'salida') return json({ error: 'Para abrir una entrega nueva primero registra tu salida con la carga.' }, 400);
      if (c0.multi_total) return json({ error: `Este furgón ya se entregó completo en ${c0.multi_total} entregas. Si llevas material de este furgón, llama a logística.` }, 409);
      if (RK.indexOf(String(c0.status || '')) < 3) pn = 1;   // nadie ha salido: este camión es la entrega 1
      else {
        const { data: ult } = await db.from('pod_parcial').select('n').eq('token', c0.token).order('n', { ascending: false }).limit(1).maybeSingle();
        pn = Math.max(2, (ult?.n || 1) + 1); nuevaParcial = true;
      }
    } else {
      pn = Number(b.parcial);
      if (!(pn >= 1)) return json({ error: 'Entrega parcial no válida.' }, 400);
      if (pn >= 2) {
        const { data: p } = await db.from('pod_parcial').select('*').eq('token', c0.token).eq('n', pn).maybeSingle();
        if (!p) return json({ error: `No existe la entrega ${pn} de este furgón.` }, 404);
        c = { ...c0, status: p.status, llegada: p.llegada, pod: p.pod, pod_at: p.pod_at };
      }
    }
  }
  const rechazar = async (motivo: string, msg: string) => {
    await db.from('pod_rechazo').insert({ token: c.token, entrega_id: c.entrega_id, folio: c.folio, accion, motivo, parcial_n: pn, tipo: String(b.tipo || '').slice(0, 80) || null,
      nombre: String(b.nombre || '').slice(0, 120) || null, nota: String(b.nota || '').slice(0, 2000) || null, hora_cel: String(b.hora_cel || '').slice(0, 60) || null });
    return json({ error: msg }, 409);
  };
  if (c.cerrado) return await rechazar('cerrado', 'Este camión ya está cerrado. ' + MSG_VIEJO);
  if (vencido(c)) return await rechazar('link viejo (POD de hace más de ' + DIAS_CIERRE + ' días)', MSG_VIEJO);
  if (!['salida', 'llegada', 'entrega', 'pod_extra', 'incidente'].includes(accion)) return json({ error: 'Acción no válida.' }, 400);
  // no repetir pasos ya registrados (Jorge 27-sep): doble clic o link viejo
  const rk = nuevaParcial ? -1 : RK.indexOf(String(c.status || ''));
  if (accion === 'salida' && rk >= 3) return json({ error: 'La salida ya estaba registrada.' }, 409);
  if (accion === 'llegada' && (rk >= 4 || c.llegada)) return json({ error: 'La llegada ya estaba registrada.' }, 409);
  if (accion === 'entrega' && (c.pod || rk >= 5)) return json({ error: 'La entrega ya estaba registrada con su POD.' }, 409);
  if (accion === 'pod_extra' && !(c.pod || rk >= 5)) return json({ error: 'Primero registra la entrega con la foto de la Carta Porte.' }, 409);
  // 6-oct: un incidente en un camión ya entregado casi siempre es el link de un viaje anterior → se rechaza con instrucciones
  if (!nuevaParcial && accion !== 'pod_extra' && (c.pod || rk >= 5)) return await rechazar('camión ya entregado', MSG_VIEJO);
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
  const txt = (x: unknown, m: number) => String(x || '').slice(0, m) || null;
  if (nuevaParcial) {
    const { error: e3 } = await db.from('pod_parcial').insert({ token: c0.token, n: pn, placas: txt(b.placas, 40), chofer: txt(b.nombre, 120), carga_txt: txt(b.carga_txt, 2000) });
    if (e3) return json({ error: 'No se pudo abrir la entrega: ' + e3.message }, 500);
  }
  const { error: e2 } = await db.from('pod_evento').insert({ token: c.token, entrega_id: c.entrega_id, accion, parcial_n: pn, placas: txt(b.placas, 40), carga_txt: txt(b.carga_txt, 2000), tipo: String(b.tipo || '').slice(0, 80) || null,
    nombre: String(b.nombre || '').slice(0, 120) || null, nota: String(b.nota || '').slice(0, 2000) || null, lat: n(b.lat), lng: n(b.lng), prec: n(b.prec),
    hora_cel: String(b.hora_cel || '').slice(0, 60) || null, fotos: rutas });
  if (e2) return json({ error: 'No se pudo registrar: ' + e2.message }, 500);
  // vista inmediata para el operador (NetSuite confirma al sincronizar)
  const ahora = new Date().toISOString();
  const upd = accion === 'salida' ? { status: 'En tránsito' } : accion === 'llegada' ? { status: 'En destino', llegada: ahora } : accion === 'entrega' ? { status: 'POD recibido', pod: true } : null;
  if (upd && pn && pn >= 2) await db.from('pod_parcial').update({ ...upd, ...(accion === 'entrega' ? { pod_at: ahora } : {}) }).eq('token', c0.token).eq('n', pn);
  else if (upd) await db.from('pod_camion').update({ ...upd, updated_at: ahora }).eq('token', c.token);
  return json({ ok: true, parcial: pn, msg: accion === 'pod_extra' ? 'Fotos agregadas a la entrega. ¡Gracias!' : accion === 'salida' ? 'Salida registrada. ¡Buen viaje!' : accion === 'llegada' ? (c.traslado ? 'Llegada al patio registrada. ¡Gracias!' : 'Llegada registrada. ¡Gracias!') : accion === 'entrega' ? (c.traslado ? 'Descarga registrada. ¡Gracias!' : 'Entrega registrada con POD. ¡Gracias!') : 'Incidente registrado. Logística será avisada.' });
}

async function privado(b: Record<string, unknown>) {
  if (b.op === 'sync') {
    const filas = (Array.isArray(b.camiones) ? b.camiones : []).filter((x: any) => tokenOk(x?.token) && x?.entrega_id)
      .map((x: any) => ({ token: x.token, entrega_id: Number(x.entrega_id), folio: x.folio ?? null, so: x.so ?? null, cliente: x.cliente ?? null, destino: x.destino ?? null,
        origen: x.origen ?? null, transportista: x.transportista ?? null, unidad: x.unidad ?? null, carga: x.carga ?? null, status: x.status ?? null,
        pod: !!x.pod, cerrado: !!x.cerrado, traslado: !!x.traslado, multi: !!x.multi, multi_total: Number(x.multi_total) || null, updated_at: new Date().toISOString() }));
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
  if (b.op === 'rechazos') {   // intentos rechazados sin avisar (los lee NetSuite y avisa a logística)
    const { data, error } = await db.from('pod_rechazo').select('*').is('avisado_at', null).order('id').limit(50);
    return error ? json({ error: error.message }, 500) : json({ ok: true, rechazos: data || [] });
  }
  if (b.op === 'rechazos_avisados') {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Boolean); if (!ids.length) return json({ ok: true, n: 0 });
    const { error } = await db.from('pod_rechazo').update({ avisado_at: new Date().toISOString() }).in('id', ids);
    return error ? json({ error: error.message }, 500) : json({ ok: true, n: ids.length });
  }
  return json({ error: 'op no válida' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') {
      const t = new URL(req.url).searchParams.get('t');
      if (!tokenOk(t)) return json({ error: 'Código no válido.' }, 400);
      const { data } = await db.from('pod_camion').select(PUBLICO + ', token').eq('token', t).maybeSingle();
      if (!data) return json({ error: 'Código no válido o vencido.' }, 404);
      if (vencido(data)) data.cerrado = true;
      const parciales = data.multi ? await parcialesDe(data) : null;
      delete (data as Record<string, unknown>).token;
      return json({ ok: true, camion: data, parciales });
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
