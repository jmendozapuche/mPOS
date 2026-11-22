#!/usr/bin/env node
// Puente HTTP -> ISO 8583 (SmartVista FE "POS Trickle Feed EMV compliant", v1.89)
// Recibe los datos de la consola i9 por HTTP y habla ISO 8583 por TCP con el switch.
// Sin dependencias: requiere solo Node.js 18+.
//
// Uso:
//   node svfe-bridge.js --switch 10.0.0.5:5000 --tid 00010001 --mid 123456789012345
//   node svfe-bridge.js --mock                      (simulador SVFE local para pruebas)
//
// Opciones (también por variables de entorno en mayúsculas, p. ej. SWITCH=host:puerto):
//   --listen 8080          Puerto HTTP local para la consola
//   --switch host:puerto   Dirección TCP del switch SmartVista
//   --header bin2|ascii4|none   Encabezado de longitud del mensaje (por defecto bin2: 2 bytes big endian)
//   --tpdu HEX             TPDU opcional antepuesto al MTI (p. ej. 6000010000)
//   --link                 Usar nivel de enlace ENQ/ACK/DLE-EOT (sección "Authorization Message Flow")
//   --f55len ascii|bcd     Formato de la longitud del DE55 (LLL ASCII o 0LLL BCD en 2 bytes)
//   --tid / --mid          DE41 (8) y DE42 (15)
//   --currency 170         DE49 y relleno de 5F2A/9F1A (170 = Colombia / COP)
//   --timeout 30           Segundos de espera de la respuesta; al vencer se envía reverso 0400 automático
//   --mock                 Levanta un simulador SVFE en 127.0.0.1:9583 y se conecta a él

'use strict';
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------- configuración ----------------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i >= 0) return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
  const env = process.env[name.toUpperCase()];
  return env !== undefined ? env : def;
};
const CFG = {
  listen: Number(opt('listen', 8080)),
  sw: opt('switch', '127.0.0.1:9583'),
  header: opt('header', 'bin2'),
  tpdu: String(opt('tpdu', '')),
  link: opt('link', false) === true || opt('link', false) === 'true',
  f55len: opt('f55len', 'ascii'),
  tid: String(opt('tid', '00010001')),
  mid: String(opt('mid', '123456789012345')),
  currency: String(opt('currency', '170')).padStart(3, '0'),
  timeout: Number(opt('timeout', 30)),
  mock: opt('mock', false) !== false,
};
if (CFG.mock) CFG.sw = '127.0.0.1:9583';
const STAN_FILE = path.join(__dirname, '.stan');

// ---------------- utilidades ----------------
const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();
const unhex = (h) => Buffer.from(String(h).replace(/[^0-9a-f]/gi, ''), 'hex');
const pad = (v, n, c = '0', right = false) => { v = String(v); return right ? v.padEnd(n, c).slice(0, n) : v.padStart(n, c).slice(-n); };
const p2 = (n) => String(n).padStart(2, '0');
function nextStan() {
  let s = 0; try { s = Number(fs.readFileSync(STAN_FILE, 'utf8')) || 0; } catch {}
  s = (s % 999999) + 1; try { fs.writeFileSync(STAN_FILE, String(s)); } catch {}
  return pad(s, 6);
}
function times(d = new Date()) {
  return {
    f7: p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()),
    f12: p2(d.getFullYear() % 100) + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()),
  };
}

// ---------------- definición de campos (sección "Field Descriptions") ----------------
// t: fixed | ll | lll ; enc: ascii | bin ; len: longitud fija (caracteres o bytes)
const FIELDS = {
  2: { t: 'll', max: 19 }, 3: { t: 'fixed', len: 6 }, 4: { t: 'fixed', len: 12 }, 5: { t: 'fixed', len: 12 },
  7: { t: 'fixed', len: 10 }, 11: { t: 'fixed', len: 6 }, 12: { t: 'fixed', len: 12 }, 14: { t: 'fixed', len: 4 },
  15: { t: 'fixed', len: 4 }, 22: { t: 'fixed', len: 3 }, 24: { t: 'fixed', len: 3 }, 25: { t: 'fixed', len: 2 },
  30: { t: 'fixed', len: 13 }, 35: { t: 'll', max: 37 }, 37: { t: 'fixed', len: 12 }, 38: { t: 'fixed', len: 6 },
  39: { t: 'fixed', len: 3 }, 41: { t: 'fixed', len: 8 }, 42: { t: 'fixed', len: 15 }, 44: { t: 'll', max: 99 },
  46: { t: 'lll', max: 999 }, 48: { t: 'lll', max: 999 }, 49: { t: 'fixed', len: 3 }, 52: { t: 'll', max: 8, enc: 'bin' },
  53: { t: 'll', max: 16, enc: 'bin' }, 54: { t: 'lll', max: 120 }, 55: { t: 'lll55', max: 255, enc: 'bin' },
  62: { t: 'lll', max: 999 }, 63: { t: 'lll', max: 999 }, 64: { t: 'fixed', len: 8, enc: 'bin' },
};

function packField(n, v) {
  const f = FIELDS[n]; if (!f) throw new Error('Campo no soportado: ' + n);
  const data = f.enc === 'bin' ? (Buffer.isBuffer(v) ? v : unhex(v)) : Buffer.from(String(v), 'ascii');
  if (f.t === 'fixed') { if (data.length !== f.len) throw new Error(`DE${n}: longitud ${data.length}, se esperaba ${f.len}`); return data; }
  if (data.length > f.max) throw new Error(`DE${n}: excede ${f.max}`);
  if (f.t === 'll') return Buffer.concat([Buffer.from(pad(data.length, 2)), data]);
  if (f.t === 'lll') return Buffer.concat([Buffer.from(pad(data.length, 3)), data]);
  if (f.t === 'lll55') {
    const l = CFG.f55len === 'bcd' ? unhex(pad(data.length, 4)) : Buffer.from(pad(data.length, 3));
    return Buffer.concat([l, data]);
  }
}

function pack(mti, fields) {
  const nums = Object.keys(fields).map(Number).filter((n) => fields[n] !== undefined && fields[n] !== null && fields[n] !== '').sort((a, b) => a - b);
  const bitmap = Buffer.alloc(8);
  for (const n of nums) { if (n > 64) throw new Error('Solo bitmap primario'); bitmap[(n - 1) >> 3] |= 0x80 >> ((n - 1) & 7); }
  const parts = [Buffer.from(mti, 'ascii'), bitmap, ...nums.map((n) => packField(n, fields[n]))];
  return Buffer.concat(parts);
}

function unpack(buf) {
  let o = 0;
  const mti = buf.slice(0, 4).toString('ascii'); o = 4;
  const bitmap = buf.slice(o, o + 8); o += 8;
  const out = { mti, bitmap: hex(bitmap), fields: {} };
  for (let n = 2; n <= 64; n++) {
    if (!(bitmap[(n - 1) >> 3] & (0x80 >> ((n - 1) & 7)))) continue;
    const f = FIELDS[n]; if (!f) throw new Error('Respuesta con campo no soportado DE' + n);
    let len;
    if (f.t === 'fixed') len = f.len;
    else if (f.t === 'll') { len = Number(buf.slice(o, o + 2).toString()); o += 2; }
    else if (f.t === 'lll') { len = Number(buf.slice(o, o + 3).toString()); o += 3; }
    else if (f.t === 'lll55') {
      if (CFG.f55len === 'bcd') { len = Number(hex(buf.slice(o, o + 2))); o += 2; } else { len = Number(buf.slice(o, o + 3).toString()); o += 3; }
    }
    const d = buf.slice(o, o + len); o += len;
    out.fields[n] = f.enc === 'bin' ? hex(d) : d.toString('ascii');
  }
  return out;
}

// ---------------- EMV ----------------
function parseBer(b) {
  const out = []; let o = 0;
  while (o < b.length) {
    if (b[o] === 0x00 || b[o] === 0xff) { o++; continue; }
    const t0 = o; if ((b[o++] & 0x1f) === 0x1f) { while (b[o++] & 0x80); }
    const tag = hex(b.slice(t0, o));
    let l = b[o++]; if (l & 0x80) { const k = l & 0x7f; l = 0; for (let i = 0; i < k; i++) l = (l << 8) | b[o++]; }
    out.push({ tag, value: b.slice(o, o + l) }); o += l;
  }
  return out;
}
const berLen = (n) => (n < 0x80 ? Buffer.from([n]) : Buffer.from([0x81, n]));
const buildBer = (list) => Buffer.concat(list.flatMap(({ tag, value }) => [unhex(tag), berLen(value.length), value]));

// Tags que el DE55 de SVFE admite en la solicitud (sección Field 55)
const F55_ALLOWED = new Set(['4F', '5F2A', '5F34', '82', '84', '8A', '95', '9A', '9B', '9C', '9F02', '9F03', '9F09', '9F10', '9F1A', '9F1E', '9F26', '9F27', '9F33', '9F34', '9F35', '9F36', '9F37', '9F41', '9F53', '9F5B']);

function buildF55(field55Hex, warnings) {
  const tags = parseBer(unhex(field55Hex));
  const cur = unhex(pad(CFG.currency, 4));
  const list = [];
  for (const t of tags) {
    if (!F55_ALLOWED.has(t.tag)) continue;
    if ((t.tag === '5F2A' || t.tag === '9F1A') && hex(t.value) === '0000') {
      warnings.push(`El lector envió ${t.tag}=0000; se reemplazó por ${hex(cur)}. El ARQC se calculó con 0000, así que un emisor que valide el criptograma lo rechazará.`);
      list.push({ tag: t.tag, value: cur }); continue;
    }
    list.push(t);
  }
  for (const req of ['5F2A', '9F1A']) if (!list.find((t) => t.tag === req)) { list.push({ tag: req, value: cur }); warnings.push(`Se agregó ${req}=${hex(cur)} porque el lector no lo envió.`); }
  const out = buildBer(list);
  if (out.length > 255) throw new Error('DE55 excede 255 bytes');
  return { f55: out, tags: list.map((t) => t.tag) };
}

// Pista 2 del lector (BCD con separador D y relleno F) -> formato z de DE35 con '='
function track2FromHex(h) {
  return String(h).toUpperCase().replace(/F+$/, '').replace('D', '=');
}

// ---------------- transporte TCP ----------------
const ENQ = 0x05, ACK = 0x06, DLE = 0x10, EOT = 0x04;
function frameOut(msg) {
  const body = CFG.tpdu ? Buffer.concat([unhex(CFG.tpdu), msg]) : msg;
  if (CFG.header === 'none') return body;
  if (CFG.header === 'ascii4') return Buffer.concat([Buffer.from(pad(body.length, 4)), body]);
  const h = Buffer.alloc(2); h.writeUInt16BE(body.length); return Buffer.concat([h, body]);
}
function tryDeframe(buf) {
  let need, start;
  if (CFG.header === 'ascii4') { if (buf.length < 4) return null; need = Number(buf.slice(0, 4).toString()); start = 4; }
  else if (CFG.header === 'none') { return { msg: buf, rest: Buffer.alloc(0) }; }
  else { if (buf.length < 2) return null; need = buf.readUInt16BE(0); start = 2; }
  if (buf.length < start + need) return null;
  let msg = buf.slice(start, start + need);
  if (CFG.tpdu) msg = msg.slice(unhex(CFG.tpdu).length);
  return { msg, rest: buf.slice(start + need) };
}

function exchange(msg, timeoutS = CFG.timeout) {
  const [host, port] = CFG.sw.split(':');
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: Number(port) });
    let buf = Buffer.alloc(0), done = false, sent = false;
    const finish = (err, res) => { if (done) return; done = true; clearTimeout(timer); try { if (CFG.link && !err) sock.write(Buffer.from([ACK, DLE, EOT])); } catch {} sock.end(); err ? reject(err) : resolve(res); };
    const timer = setTimeout(() => finish(Object.assign(new Error('Tiempo de espera agotado'), { code: 'TIMEOUT' })), timeoutS * 1000);
    const send = () => { sent = true; sock.write(frameOut(msg)); };
    sock.on('connect', () => { if (!CFG.link) send(); });
    sock.on('data', (d) => {
      if (CFG.link) {
        // descartar caracteres de control del nivel de enlace
        let i = 0; while (i < d.length && [ENQ, ACK].includes(d[i]) && !(buf.length)) { if (d[i] === ENQ && !sent) send(); i++; }
        d = d.slice(i);
      }
      buf = Buffer.concat([buf, d]);
      const fr = tryDeframe(buf);
      if (fr) finish(null, fr.msg);
    });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('El switch cerró la conexión sin responder')));
  });
}

// ---------------- operaciones ----------------
const RC = { '000': 'Aprobada', '001': 'Aprobada con identificación', '003': 'Aprobada', '100': 'No honrar', '101': 'Tarjeta vencida', '106': 'Excede intentos de PIN', '110': 'Monto inválido', '111': 'Tarjeta inválida', '116': 'Fondos insuficientes', '117': 'PIN incorrecto', '119': 'No permitida por ley', '121': 'Excede límite', '123': 'Excede número de transacciones', '902': 'Transacción inválida', '903': 'Reingresar transacción', '909': 'Mal funcionamiento', '911': 'Emisor sin respuesta', '913': 'Transacción duplicada', '914': 'Original no encontrada' };

async function send(mti, fields) {
  const req = pack(mti, fields);
  const t0 = Date.now();
  const raw = await exchange(req);
  const res = unpack(raw);
  const resp = { ...res, fields: redact(res.fields), rcText: RC[res.fields[39]] || '', hex: res.fields[2] || res.fields[35] ? '(oculto: contiene datos de tarjeta)' : hex(raw) };
  if (res.fields[55]) resp.fields[55] = res.fields[55]; // DE55 de respuesta (ARPC/scripts) se necesita completo
  return { request: { mti, fields: redact(fields), hex: redactHex(req, fields) }, response: resp, ms: Date.now() - t0 };
}

// No registrar PAN ni pista completos
function redact(fields) {
  const f = { ...fields };
  if (f[2]) f[2] = maskPan(f[2]);
  if (f[35]) f[35] = maskPan(f[35].split('=')[0]) + '=****';
  if (f[55]) f[55] = '(' + (Buffer.isBuffer(f[55]) ? f[55].length : unhex(f[55]).length) + ' bytes)';
  if (f[52]) f[52] = '(PIN cifrado)';
  return f;
}
const maskPan = (p) => p.slice(0, 6) + '*'.repeat(Math.max(0, p.length - 10)) + p.slice(-4);
const redactHex = (b, fields) => (fields[35] || fields[2] ? '(oculto: contiene datos de tarjeta)' : hex(b));

async function echo() {
  const t = times();
  return send('0800', { 3: '990000', 7: t.f7, 11: nextStan(), 24: '831', 41: CFG.tid, 42: CFG.mid });
}

function entryMode(card) {
  const type = parseInt(String(card.cardType || '00').slice(0, 2), 16) & 0x07;
  const hasChip = !!card.field55;
  const pin = card.pinBlock ? '1' : '0';
  if (type === 3) return (hasChip ? '07' : '91') + pin;   // sin contacto
  if (type === 1 || type === 2) return (hasChip ? '05' : '08') + pin; // chip
  return '02' + pin;                                       // banda
}

const lastTx = new Map(); // stan -> datos para reverso

async function purchase(body) {
  const warnings = [];
  const amount = pad(Math.round(Number(body.amountCents)), 12);
  if (!(Number(body.amountCents) > 0)) throw new Error('amountCents inválido');
  let t2 = body.track2 ? track2FromHex(body.track2) : '';
  if (!t2 && body.field55) { const t57 = parseBer(unhex(body.field55)).find((t) => t.tag === '57'); if (t57) t2 = track2FromHex(hex(t57.value)); }
  if (!t2) throw new Error('No hay pista 2 (DE35)');
  const t = times();
  const f = {
    3: '000000', 4: amount, 7: t.f7, 11: nextStan(), 12: t.f12,
    22: body.entryMode || entryMode(body), 24: '200', 25: '00', 35: t2,
    41: pad(body.tid || CFG.tid, 8, ' ', true), 42: pad(body.mid || CFG.mid, 15, ' ', true), 49: CFG.currency,
  };
  if (body.pinBlock) f[52] = body.pinBlock;
  if (body.field55) {
    const r = buildF55(body.field55, warnings);
    f[55] = r.f55;
    const t9F02 = parseBer(r.f55).find((x) => x.tag === '9F02');
    if (t9F02 && hex(t9F02.value) !== amount) warnings.push(`9F02 (${hex(t9F02.value)}) no coincide con DE4 (${amount}).`);
  }
  lastTx.set(f[11], f);
  try {
    const r = await send('0200', f);
    r.warnings = warnings; r.stan = f[11];
    return r;
  } catch (e) {
    if (e.code === 'TIMEOUT') {
      const rev = await reversal({ stan: f[11] }).catch((er) => ({ error: er.message }));
      return { error: 'Sin respuesta del switch: se envió reverso automático', reversal: rev, warnings, stan: f[11] };
    }
    throw e;
  }
}

async function reversal(body) {
  const o = lastTx.get(body.stan);
  if (!o) throw new Error('No se encontró la transacción original con STAN ' + body.stan);
  const t = times();
  const f = { ...o, 7: t.f7, 24: '400' };
  if (body.rrn) f[37] = pad(body.rrn, 12, ' ', true);
  // En el reverso, DE55 solo con 95, 9F1E, 9F10, 9F36, 9F5B
  if (o[55]) {
    const keep = parseBer(o[55]).filter((x) => ['95', '9F1E', '9F10', '9F36', '9F5B'].includes(x.tag));
    f[55] = keep.length ? buildBer(keep) : undefined;
  }
  return send('0400', f);
}

// ---------------- simulador SVFE (--mock) ----------------
function startMock() {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    if (CFG.link) sock.write(Buffer.from([ENQ]));
    sock.on('data', (d) => {
      if (CFG.link && !buf.length) { let i = 0; while (i < d.length && [ACK, DLE, EOT].includes(d[i])) i++; d = d.slice(i); }
      buf = Buffer.concat([buf, d]);
      const fr = tryDeframe(buf); if (!fr) return; buf = fr.rest;
      const req = unpack(fr.msg); const q = req.fields; let mti, f;
      const rrn = pad(Date.now() % 1e12, 12);
      if (req.mti === '0800') { mti = '0810'; f = { 3: q[3], 7: q[7], 11: q[11], 37: rrn, 39: '000', 41: q[41] }; }
      else if (req.mti === '0200') {
        const cents = Number(q[4]);
        const rc = cents % 100 === 51 ? '116' : '000'; // monto terminado en ,51 => fondos insuficientes
        mti = '0210'; f = { 3: q[3], 4: q[4], 7: q[7], 11: q[11], 12: q[12], 37: rrn, 39: rc, 41: q[41], 49: q[49] };
        if (rc === '000') f[38] = pad(Math.floor(Math.random() * 1e6), 6);
        if (q[55]) f[55] = buildBer([{ tag: '8A', value: Buffer.from(rc === '000' ? '00' : '51') }, { tag: '91', value: unhex('0102030405060708' + '3030') }]);
      } else if (req.mti === '0400') { mti = '0410'; f = { 3: q[3], 4: q[4], 7: q[7], 11: q[11], 12: q[12], 37: q[37] || rrn, 39: '000', 41: q[41], 49: q[49] }; }
      else return sock.end();
      if (CFG.link) sock.write(Buffer.from([ACK]));
      sock.write(frameOut(pack(mti, f)));
    });
    sock.on('error', () => {});
  });
  srv.listen(9583, '127.0.0.1', () => console.log('Simulador SVFE escuchando en 127.0.0.1:9583'));
}

// ---------------- servidor HTTP para la consola ----------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // la consola en HTTPS llama a localhost
}
const ROUTES = { '/echo': echo, '/purchase': purchase, '/reversal': reversal };

function startHttp() {
http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, switch: CFG.sw, header: CFG.header, tpdu: CFG.tpdu, link: CFG.link, f55len: CFG.f55len, tid: CFG.tid, mid: CFG.mid, currency: CFG.currency, mock: CFG.mock });
  const fn = ROUTES[req.url];
  if (req.method !== 'POST' || !fn) return send(404, { error: 'Ruta no encontrada' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    try {
      const out = await fn(body ? JSON.parse(body) : {});
      const r = out.response;
      console.log(`${new Date().toISOString()} ${req.url} -> ${r ? r.mti + ' DE39=' + r.fields[39] : out.error}`);
      send(200, out);
    } catch (e) { console.error(req.url, e.message); send(502, { error: e.message }); }
  });
}).listen(CFG.listen, () => {
  console.log(`Puente i9 -> SmartVista en http://localhost:${CFG.listen}  (switch ${CFG.sw}, encabezado ${CFG.header}${CFG.tpdu ? ', TPDU ' + CFG.tpdu : ''}${CFG.link ? ', ENQ/ACK' : ''}, DE55 ${CFG.f55len})`);
});
}
if (require.main === module) { startHttp(); if (CFG.mock) startMock(); }

module.exports = { pack, unpack, parseBer, buildF55, track2FromHex };
