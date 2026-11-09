// NT Carrier Portal · patio-api (Supabase Edge Function, verify_jwt = false) · 8-nov-2026
// Portal del PATIO: un QR / liga por furgón en el correo de «Instrucciones patio». APARTE del QR del chofer (pod-api): otras tablas,
// otro bucket, otra página (patio.html). Empieza con LINSA (Jorge 7-nov).
// Público (lo llama patio.html con el token del furgón):
//   GET  ?t=<token>                                   → ficha del furgón (sin precios)
//   POST {t, accion, fecha?, so_id?, fotos[], nombre, nota, hora_cel}
//        accion = llegada     → «✔ Llegó» (fecha y hora; las fotos pueden venir después)
//                 fotos       → fotos del furgón (obligatorias, cuando las tengan)
//                 entregamos  → el patio entregó al cliente (con foto / reporte de salida)
//                 recogio     → el cliente recogió en el patio (con foto / reporte de salida)
// Privado (lo llama NetSuite con el header x-pod-secret = POD_SECRET, la misma clave de la configuración):
//   POST {op:'sync', furgones:[…]}   → alta / actualización de furgones (token, lg_id, ficha…)
//   POST {op:'pendientes', max}      → eventos sin procesar con sus fotos en base64
//   POST {op:'procesado', id, error?}
import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SECRET = Deno.env.get('POD_SECRET') || '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-pod-secret', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const tokenOk = (t: unknown) => typeof t === 'string' && t.length >= 24 && /^[A-Za-z0-9-]+$/.test(t);
const PUBLICO = 'icpo, patio, carro, eta, dias_libres, ficha, llegada, fotos_n, salidas, cerrado';
const ACC = ['llegada', 'fotos', 'entregamos', 'recogio'];

function b64ToBytes(b64: string) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(u: Uint8Array) { let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode(...u.subarray(i, i + CH)); return btoa(s); }
const txt = (x: unknown, m: number) => String(x ?? '').slice(0, m) || null;

async function registrar(b: Record<string, unknown>) {
  if (!tokenOk(b.t)) return json({ error: 'Código no válido. Abre de nuevo la liga del correo de instrucciones.' }, 400);
  const { data: f } = await db.from('patio_furgon').select('token, lg_id, llegada, fotos_n, salidas, cerrado, ficha').eq('token', b.t).maybeSingle();
  if (!f) return json({ error: 'Código no válido o vencido.' }, 404);
  if (f.cerrado) return json({ error: 'Este furgón ya se cerró. Si hay algo pendiente, escríbanos por correo.' }, 409);
  const accion = String(b.accion || '');
  if (!ACC.includes(accion)) return json({ error: 'Acción no válida.' }, 400);

  // fecha capturada (llegada / salida): no futura, no más de 30 días atrás
  let fecha: string | null = null;
  if (accion !== 'fotos') {
    const t = b.fecha ? Date.parse(String(b.fecha)) : Date.now();
    if (!isFinite(t)) return json({ error: 'Fecha no válida.' }, 400);
    if (t > Date.now() + 2 * 3600 * 1000) return json({ error: 'La fecha no puede ser futura.' }, 400);
    if (t < Date.now() - 30 * 86400000) return json({ error: 'La fecha es de hace más de 30 días: escríbanos por correo.' }, 400);
    fecha = new Date(t).toISOString();
  }
  if (accion === 'llegada' && f.llegada) return json({ error: 'La llegada ya estaba registrada.' }, 409);
  let soId: number | null = null;
  if (accion === 'entregamos' || accion === 'recogio') {
    if (!f.llegada) return json({ error: 'Primero confirmen la llegada del furgón.' }, 409);
    const ventas = (f.ficha?.ventas || []) as { so_id: number }[];
    soId = Number(b.so_id) || (ventas.length === 1 ? Number(ventas[0].so_id) : null);
    if (!soId || !ventas.some((v) => Number(v.so_id) === soId)) return json({ error: 'Elijan de qué cliente / venta es la salida.' }, 400);
  }
  const fotos = (Array.isArray(b.fotos) ? b.fotos : []).slice(0, 15) as { base64?: string }[];
  if ((accion === 'fotos' || accion === 'entregamos' || accion === 'recogio') && !fotos.length)
    return json({ error: accion === 'fotos' ? 'Agreguen al menos una foto.' : 'Agreguen la foto del reporte de salida o de la carga.' }, 400);
  const rutas: string[] = [];
  for (let i = 0; i < fotos.length; i++) {
    const x = fotos[i]; if (!x?.base64) continue;
    const bytes = b64ToBytes(x.base64);
    if (bytes.length > 4 * 1024 * 1024) return json({ error: 'Una foto pesa demasiado; vuelvan a tomarla.' }, 413);
    const ruta = `${f.lg_id}/${accion}_${Date.now()}_${i + 1}.jpg`;
    const { error } = await db.storage.from('patio').upload(ruta, bytes, { contentType: 'image/jpeg', upsert: false });
    if (error) return json({ error: 'No se pudo guardar la foto: ' + error.message }, 500);
    rutas.push(ruta);
  }
  const { error: e2 } = await db.from('patio_evento').insert({ token: f.token, lg_id: f.lg_id, accion, fecha, so_id: soId, nombre: txt(b.nombre, 120),
    nota: txt(b.nota, 2000), hora_cel: txt(b.hora_cel, 60), fotos: rutas });
  if (e2) return json({ error: 'No se pudo registrar: ' + e2.message }, 500);
  // vista inmediata (NetSuite lo aplica en la siguiente sincronización, máximo 15 min)
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (accion === 'llegada') upd.llegada = fecha;
  if (rutas.length) upd.fotos_n = (f.fotos_n || 0) + (accion === 'entregamos' || accion === 'recogio' ? 0 : rutas.length);
  if (soId) upd.salidas = [...(f.salidas || []), { so_id: soId, tipo: accion, at: fecha }];
  await db.from('patio_furgon').update(upd).eq('token', f.token);
  const msg = accion === 'llegada' ? (rutas.length ? 'Llegada registrada con fotos. ¡Gracias!' : 'Llegada registrada. No olviden mandar las fotos del furgón.')
    : accion === 'fotos' ? 'Fotos recibidas. ¡Gracias!' : accion === 'entregamos' ? 'Entrega registrada. ¡Gracias!' : 'Registrado: el cliente recogió. ¡Gracias!';
  return json({ ok: true, msg });
}

async function privado(b: Record<string, unknown>) {
  if (b.op === 'sync') {
    const L = (Array.isArray(b.furgones) ? b.furgones : []).filter((x: any) => tokenOk(x?.token) && x?.lg_id && x?.icpo_id);
    for (const x of L as any[]) {
      const fila = { token: x.token, lg_id: Number(x.lg_id), icpo_id: Number(x.icpo_id), icpo: x.icpo ?? null, patio: x.patio ?? null, carro: x.carro ?? null,
        eta: x.eta || null, dias_libres: Number(x.dias_libres) || null, ficha: x.ficha || {}, cerrado: !!x.cerrado, updated_at: new Date().toISOString() };
      const { error } = await db.from('patio_furgon').upsert(fila, { onConflict: 'token' });
      if (error) return json({ error: error.message }, 500);
      // si logística ya capturó la Fecha patio en NetSuite, la ficha la muestra (sin pisar la hora que registró el patio)
      if (x.llegada_ns) await db.from('patio_furgon').update({ llegada: x.llegada_ns + 'T12:00:00-06:00' }).eq('token', x.token).is('llegada', null);
    }
    return json({ ok: true, n: L.length });
  }
  if (b.op === 'pendientes') {
    const max = Math.min(Number(b.max) || 5, 10);
    const { data, error } = await db.from('patio_evento').select('*').is('procesado_at', null).lt('intentos', 5).order('id').limit(max);
    if (error) return json({ error: error.message }, 500);
    const out = [];
    for (const ev of data || []) {
      const fotos = [];
      for (const ruta of ev.fotos || []) {
        const { data: blob } = await db.storage.from('patio').download(ruta);
        if (blob) fotos.push({ ruta, base64: bytesToB64(new Uint8Array(await blob.arrayBuffer())) });
      }
      out.push({ ...ev, fotos });
    }
    return json({ ok: true, eventos: out });
  }
  if (b.op === 'procesado') {
    const id = Number(b.id); if (!id) return json({ error: 'id' }, 400);
    if (b.error) {
      const { data: ev } = await db.from('patio_evento').select('intentos').eq('id', id).maybeSingle();
      await db.from('patio_evento').update({ intentos: (ev?.intentos || 0) + 1, error: String(b.error).slice(0, 1000) }).eq('id', id);
    } else await db.from('patio_evento').update({ procesado_at: new Date().toISOString(), error: null }).eq('id', id);
    return json({ ok: true });
  }
  return json({ error: 'op no válida' }, 400);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') {
      const t = new URL(req.url).searchParams.get('t');
      if (!tokenOk(t)) return json({ error: 'Código no válido.' }, 400);
      const { data } = await db.from('patio_furgon').select(PUBLICO).eq('token', t).maybeSingle();
      return data ? json({ furgon: data }) : json({ error: 'Código no válido o vencido.' }, 404);
    }
    const b = await req.json().catch(() => ({}));
    if (b && b.op) {
      if (!SECRET || req.headers.get('x-pod-secret') !== SECRET) return json({ error: 'No autorizado' }, 401);
      return await privado(b);
    }
    return await registrar(b || {});
  } catch (e) {
    return json({ error: 'Error: ' + ((e as Error).message || e) }, 500);
  }
});
