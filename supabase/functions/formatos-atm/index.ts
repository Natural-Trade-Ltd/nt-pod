// NT Carrier Portal · formatos-atm (Supabase Edge Function, verify_jwt = false) · 25-sep-2026
// Llena los Excel ORIGINALES de Grupo Multimodal / ATM (Altamira) con los datos de un movimiento de contenedores:
//   tipo 'maniobras' → «Solicitud de servicios para maniobras generales» (hoja Vertical; hasta 5 renglones por archivo)
//   tipo 'ccp'       → «SGC-TRN-FR-001 Solicitud CCP» (origen ATP o IPM; hasta 4 renglones por archivo)
// POST {tipo, datos} → {archivos:[{nombre, base64}]}. No guarda nada ni lee datos de nadie: solo transforma lo que recibe.
// Pedimento, UUID, área solicitada y datos de operador/unidad se dejan en blanco (los llena la agencia o ATM).
import ExcelJS from 'npm:exceljs@4.4.0';
import { TPL_MANIOBRAS, TPL_CCP } from './plantillas.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

// Bloque «Origen» del CCP según la terminal (datos tomados de los formatos de ATP e IPM)
const TERMINALES: Record<string, Record<string, unknown>> = {
  ATP: { B12: 'ALTAMIRA TERMINAL PORTUARIA, S.A DE C.V.', G12: 'ATP950725GZ3', I12: '', B14: 'TERMINAL DE USOS MULTIPLES', E14: '', F14: 1,
    G14: 'PUERTO INDUSTRIAL - 3841', I14: 'ALTAMIRA-01', B16: 'ALTAMIRA-003', E16: 'TAMAULIPAS - TAM', G16: 89603, I16: 'MÉXICO' },
  IPM: { B12: 'INFRAESTRUCTURA PORTUARIA MEXICANA SA DE CV', G12: 'IPM-931213-AV3', I12: '', B14: 'TERMINAL DE USOS MULTIPLES', E14: 2, F14: '',
    G14: 'ALTAMIRA CENTRO-3841', I14: '', B16: 'ALTAMIRA-003', E16: 'TAMAULIPAS-TAM', G16: 89600, I16: 'MÉXICO' },
};

type Camion = { contenedores: string[]; peso?: number };
type Datos = {
  fecha?: string; hora?: string; fecha_req?: string; naviera?: string; buque?: string; eta?: string; puerto?: string; bl?: string; booking?: string;
  terminal?: string; destino?: Record<string, unknown>; camiones: Camion[]; sat?: { clave?: string; desc?: string; fraccion?: string }; ref?: string;
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(u: Uint8Array) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
const fecha = (s?: string) => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : null; };
const pesoDe = (c: Camion) => c.peso || (c.contenedores.length >= 2 ? 50000 : 25000);   // Jorge: siempre 25 t / 50 t
const trozos = <T,>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function libro(tpl: string) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(b64ToBytes(tpl)); return wb; }
async function salida(wb: ExcelJS.Workbook) { return bytesToB64(new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)); }
const set = (ws: ExcelJS.Worksheet, dir: string, v: unknown) => { ws.getCell(dir).value = (v === undefined ? null : v) as ExcelJS.CellValue; };

async function maniobras(d: Datos) {
  const out = [];
  const grupos = trozos(d.camiones, 5);
  for (let g = 0; g < grupos.length; g++) {
    const wb = await libro(TPL_MANIOBRAS);
    const ws = wb.getWorksheet('Vertical')!;
    set(ws, 'V3', fecha(d.fecha) || new Date());
    set(ws, 'F24', d.naviera || ''); set(ws, 'K24', d.buque || ''); set(ws, 'P24', fecha(d.eta) || d.eta || '');
    set(ws, 'U24', (d.puerto || '').toUpperCase()); set(ws, 'Z24', d.bl || d.booking || '');
    set(ws, 'P45', fecha(d.fecha_req) || fecha(d.fecha) || new Date());
    for (let r = 56; r <= 60; r++) ['B', 'C', 'I', 'K', 'Q', 'AA'].forEach((c) => set(ws, c + r, null));
    grupos[g].forEach((cam, i) => {
      const r = 56 + i;
      set(ws, 'B' + r, g * 5 + i + 1); set(ws, 'C' + r, cam.contenedores.join(' / ')); set(ws, 'I' + r, cam.contenedores.length);
      set(ws, 'K' + r, '40 HC'); set(ws, 'Q' + r, 'ATADOS DE MADERA'); set(ws, 'AA' + r, pesoDe(cam));
    });
    out.push({ nombre: `Solicitud_maniobras${d.ref ? '_' + d.ref : ''}${grupos.length > 1 ? '_' + (g + 1) : ''}.xlsx`, base64: await salida(wb) });
  }
  return out;
}

async function ccp(d: Datos) {
  const out = [];
  const t = TERMINALES[String(d.terminal || 'ATP').toUpperCase()] || TERMINALES.ATP;
  const grupos = trozos(d.camiones, 4);
  for (let g = 0; g < grupos.length; g++) {
    const wb = await libro(TPL_CCP);
    const ws = wb.getWorksheet('TRN-FR-001')!;
    set(ws, 'B4', fecha(d.fecha) || new Date()); set(ws, 'E4', d.hora || '07:00');
    Object.keys(t).forEach((k) => set(ws, k, t[k]));
    const de = d.destino || {};
    if (de.nombre) {
      const map: Record<string, string> = { B19: 'nombre', G19: 'rfc', I19: 'tel', B21: 'calle', E21: 'num_int', F21: 'num_ext', G21: 'colonia', I21: 'localidad',
        B23: 'municipio', E23: 'estado', G23: 'cp', I23: 'pais' };
      Object.keys(map).forEach((k) => set(ws, k, (de[map[k]] as string) ?? ''));
    }
    for (let r = 28; r <= 31; r++) ['D', 'E', 'F', 'G', 'H', 'I', 'J'].forEach((c) => set(ws, c + r, null));
    let nCont = 0, total = 0;
    grupos[g].forEach((cam, i) => {
      const r = 28 + i; const p = pesoDe(cam); nCont += cam.contenedores.length; total += p;
      set(ws, 'D' + r, g * 4 + i + 1); set(ws, 'E' + r, cam.contenedores[0] || ''); set(ws, 'F' + r, cam.contenedores[1] || '');
      set(ws, 'G' + r, p); set(ws, 'H' + r, 'KG'); set(ws, 'I' + r, p); set(ws, 'J' + r, 'KG');
    });
    const sat = d.sat || {};
    set(ws, 'C42', `${sat.clave || '11121616'}\n${sat.desc || 'Madera Aserrada'}`); set(ws, 'D42', nCont); set(ws, 'E42', 'CONTENEDOR');
    set(ws, 'F42', total); set(ws, 'H42', total); set(ws, 'I42', sat.fraccion || '');
    set(ws, 'E46', sat.desc || 'Madera Aserrada'); set(ws, 'H46', 'NO');
    out.push({ nombre: `Solicitud_CCP_${String(d.terminal || 'ATP').toUpperCase()}${d.ref ? '_' + d.ref : ''}${grupos.length > 1 ? '_' + (g + 1) : ''}.xlsx`, base64: await salida(wb) });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const d = b?.datos as Datos;
    if (!d || !Array.isArray(d.camiones) || !d.camiones.length) return json({ error: 'Faltan los camiones / contenedores.' }, 400);
    d.camiones = d.camiones.map((c) => ({ ...c, contenedores: (c.contenedores || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2) }));
    if (b.tipo === 'maniobras') return json({ ok: true, archivos: await maniobras(d) });
    if (b.tipo === 'ccp') return json({ ok: true, archivos: await ccp(d) });
    if (b.tipo === 'ambos') return json({ ok: true, archivos: [...await maniobras(d), ...await ccp(d)] });
    return json({ error: 'tipo no válido (maniobras | ccp | ambos)' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
