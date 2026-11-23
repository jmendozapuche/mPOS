// Librería mínima para el lector i9 por Web Bluetooth (protocolo i9 UART V2.1)
// Uso: const r = new I9Reader(); await r.connect(); const card = await r.transaction({ cents: 1000 });
(function (global) {
  'use strict';
  const SVC = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
  const CH_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616';
  const CH_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3';

  const STATUS = { 0x80: 'received', 0x84: 'chip_inserted', 0x85: 'chip_removed', 0x86: 'chip_failed', 0x89: 'remove_nfc', 0x8A: 'nfc_detected', 0x8B: 'nfc_failed', 0x8C: 'use_other', 0x8F: 'use_nfc', 0xD7: 'present_card' };
  const ERRORS = { 0x01: 'Tiempo agotado', 0x0A: 'Cancelado', 0x72: 'Error leyendo la banda', 0x73: 'No se obtuvo el vencimiento', 0x74: 'Error en datos del chip', 0x81: 'Error leyendo la banda', 0x82: 'Falló el deslizado', 0x86: 'Falló la lectura del chip', 0x8B: 'Falló la lectura sin contacto', 0x8C: 'Use otro medio de pago', 0x8D: 'Sin servicio', 0x8E: 'La tarjeta rechazó la transacción', 0x90: 'Falló la lectura del chip', 0x9E: 'Transacción restringida', 0xD4: 'Error de tarjeta sin contacto', 0xEA: 'Terminal bloqueado', 0xF7: 'Datos inválidos', 0xFC: 'Datos inválidos', 0xFF: 'Error de comunicación' };

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const unhex = (h) => Uint8Array.from((h.replace(/[^0-9a-f]/gi, '').match(/../g) || []), (x) => parseInt(x, 16));
  const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const tlv1 = (tag, v) => tag + (v.length / 2).toString(16).padStart(2, '0').toUpperCase() + v;

  function frame(body) {
    const len = body.length + 1;
    const pre = concat(Uint8Array.of(0x4D, len >> 8, len & 0xff, 0x00), body);
    let x = 0; for (const b of pre) x ^= b;
    return concat(pre, Uint8Array.of(x));
  }
  const cmd = (p, s, t, data = new Uint8Array()) => concat(Uint8Array.of(p, s, t, data.length >> 8, data.length & 0xff), data);

  function parseTlv2(d) {
    const out = {}; let o = 0;
    while (o + 3 <= d.length) {
      const tag = hex(d.slice(o, o + 2)); o += 2;
      let l = d[o++];
      if (l === 0x81) l = d[o++]; else if (l === 0x82) { l = (d[o] << 8) | d[o + 1]; o += 2; }
      out[tag] = d.slice(o, o + l); o += l;
    }
    return out;
  }
  function parseBer(d) {
    const out = []; let o = 0;
    while (o < d.length) {
      if (d[o] === 0x00 || d[o] === 0xFF) { o++; continue; }
      const t0 = o; if ((d[o++] & 0x1F) === 0x1F) { while (d[o++] & 0x80); }
      const tag = hex(d.slice(t0, o));
      let l = d[o++]; if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = (l << 8) | d[o++]; }
      out.push({ tag, value: d.slice(o, o + l) }); o += l;
    }
    return out;
  }
  function field55From1F48(v) {
    if ([0x9F, 0x5F, 0x82, 0x95, 0x4F, 0x57].includes(v[0])) return hex(v);
    try { // formato del documento: len(2)+lenSeq+seq+CVM(3)+len55(2)+55
      let o = 2; const sl = v[o++]; o += sl + 3; const l = (v[o] << 8) | v[o + 1]; o += 2;
      const f = v.slice(o, o + l); if (f.length === l && l) return hex(f);
    } catch (e) {}
    return hex(v);
  }
  const BRANDS = { 1: 'UnionPay', 2: 'Visa', 3: 'Mastercard', 4: 'Discover', 5: 'Amex', 6: 'JCB' };
  function brandFromAid(aid) {
    if (!aid) return '';
    if (aid.startsWith('A000000003')) return 'Visa';
    if (aid.startsWith('A000000004')) return 'Mastercard';
    if (aid.startsWith('A000000025')) return 'Amex';
    if (aid.startsWith('A000000065')) return 'JCB';
    if (aid.startsWith('A000000152')) return 'Discover';
    if (aid.startsWith('A000000333')) return 'UnionPay';
    return '';
  }

  class I9Reader extends EventTarget {
    constructor() { super(); this.device = null; this.ch = null; this.rx = new Uint8Array(); this.waiters = []; }
    get connected() { return !!(this.device && this.device.gatt.connected); }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

    async connect() {
      if (!navigator.bluetooth) throw new Error('Este navegador no soporta Bluetooth. Use Chrome en Android o en computador.');
      this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SVC] });
      return this._open();
    }
    async reconnect() { if (!this.device) throw new Error('Sin lector'); return this._open(); }
    async _open() {
      this.device.ongattserverdisconnected = () => this.emit('disconnected');
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);
      this.ch = await svc.getCharacteristic(CH_WRITE);
      const n = await svc.getCharacteristic(CH_NOTIFY);
      await n.startNotifications();
      n.addEventListener('characteristicvaluechanged', (e) => this._onData(new Uint8Array(e.target.value.buffer)));
      this.emit('connected', { name: this.device.name });
      return this.device.name;
    }
    disconnect() { if (this.connected) this.device.gatt.disconnect(); }

    async _write(bytes) {
      const nr = this.ch.properties.writeWithoutResponse;
      for (let i = 0; i < bytes.length; i += 20) {
        const c = bytes.slice(i, i + 20);
        if (nr) await this.ch.writeValueWithoutResponse(c); else await this.ch.writeValueWithResponse(c);
      }
    }
    _onData(chunk) {
      this.rx = concat(this.rx, chunk);
      while (this.rx.length >= 4) {
        const s = this.rx.indexOf(0x6D);
        if (s < 0) { this.rx = new Uint8Array(); return; }
        if (s > 0) this.rx = this.rx.slice(s);
        if (this.rx.length < 4) return;
        const total = 3 + ((this.rx[1] << 8) | this.rx[2]) + 1;
        if (this.rx.length < total) return;
        const fr = this.rx.slice(0, total); this.rx = this.rx.slice(total);
        const b = fr.slice(4, total - 1);
        const key = hex(b.slice(0, 2)), err = b[2], dlen = (b[3] << 8) | b[4], data = b.slice(5, 5 + dlen);
        if (key === '02A0' && err >= 0x80 && dlen === 0) { this.emit('status', { code: err, name: STATUS[err] || 'other' }); continue; }
        const w = this.waiters.findIndex((x) => x.key === key);
        if (w >= 0) { const [x] = this.waiters.splice(w, 1); clearTimeout(x.timer); x.resolve({ err, data }); }
      }
    }
    request(body, waitS) {
      const key = hex(body.slice(0, 2));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x.key !== key || x.resolve !== resolve); reject(new Error('El lector no respondió')); }, (waitS || body[2] + 5) * 1000);
        this.waiters.push({ key, resolve, timer });
        this._write(frame(body)).catch((e) => { clearTimeout(timer); reject(e); });
      });
    }

    async battery() { const r = await this.request(cmd(0x09, 0x13, 10)); return (r.data[0] << 8) | r.data[1]; }
    async cancel() { try { await this.request(cmd(0x09, 0x07, 5)); } catch (e) {} }

    // Inicia una transacción y espera la tarjeta. Devuelve los datos para el switch.
    async transaction({ cents, timeout = 60, mode = '70', keySys = '01', keyIdx = 0, extra = '33' }) {
      const now = new Date(), p = (n) => String(n).padStart(2, '0');
      const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      const amt = hex(new TextEncoder().encode(String(cents)));
      const body = tlv1('1F01', mode) + tlv1('1F04', keySys + keyIdx.toString(16).padStart(2, '0')) + tlv1('1F02', '10633630') +
        tlv1('1F03', date) + tlv1('1F07', '313233') + tlv1('1F08', amt) + tlv1('1F09', extra) + tlv1('1F0A', '3839');
      const r = await this.request(cmd(0x02, 0xA0, timeout, unhex(body)), timeout + 10);
      if (r.err !== 0) { const e = new Error(ERRORS[r.err] || 'Error del lector 0x' + r.err.toString(16)); e.code = r.err; throw e; }
      const t = parseTlv2(r.data);
      const field55 = t['1F48'] ? field55From1F48(t['1F48']) : '';
      const emv = {}; if (field55) for (const x of parseBer(unhex(field55))) emv[x.tag] = hex(x.value);
      let track2 = t['1F40'] ? hex(t['1F40']) : (emv['57'] || '');
      const pan = track2 ? track2.split('D')[0] : (t['1F51'] ? new TextDecoder().decode(t['1F51']) : '');
      const ctype = t['1F41'] ? t['1F41'][0] & 0x07 : 0;
      const aid = emv['84'] || emv['4F'] || emv['9F06'] || '';
      return {
        // datos para el puente (no se guardan)
        bridge: { cardType: t['1F41'] ? hex(t['1F41']) : '', track2, field55, pinBlock: t['1F47'] ? hex(t['1F47']) : undefined, amountCents: cents },
        // datos para mostrar (enmascarados)
        last4: pan.slice(-4),
        bin: pan.slice(0, 6),
        brand: (t['1F41'] && BRANDS[t['1F41'][1]]) || brandFromAid(aid) || 'Tarjeta',
        entry: ctype === 3 ? 'Sin contacto' : ctype === 1 || ctype === 2 ? (field55 ? 'Chip' : 'Banda') : 'Banda',
        aid, arqc: emv['9F26'] || '', atc: emv['9F36'] || '', currency: emv['5F2A'] || '', country: emv['9F1A'] || '',
        pin: !!t['1F47'],
      };
    }
    // Devuelve al chip el DE55 de la respuesta del emisor. true = la tarjeta acepta.
    async writeBack(de55Hex) {
      const r = await this.request(cmd(0x02, 0xA1, 30, unhex(de55Hex)));
      return { ok: r.err === 0 && r.data[0] === 0, raw: hex(r.data) };
    }
  }

  global.I9Reader = I9Reader;
  global.I9Util = { hex, unhex, parseBer, frame, cmd };
})(window);
