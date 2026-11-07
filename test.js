'use strict';
/* End-to-end test of server.js: `node test.js` (starts its own server instances on free ports, needs Node >= 22 for the built-in WebSocket client). */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const assert = require('assert');

let pass = 0, fail = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function t(name, f) { try { await f(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); } }

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { PORT: String(port) }, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; p.stdout.on('data', d => { if (!up && /listening/.test(String(d))) { up = true; resolve({ port, p, stop: () => p.kill('SIGKILL') }); } });
    p.stderr.on('data', d => process.stderr.write('[server] ' + d));
    p.on('exit', () => { if (!up) reject(new Error('server did not start')); });
    setTimeout(() => { if (!up) reject(new Error('server start timeout')); }, 5000);
  });
}
function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port), c = { ws, msgs: [], closed: false, code: null };
    ws.onmessage = e => { c.msgs.push(JSON.parse(e.data)); };
    ws.onclose = e => { c.closed = true; c.code = e.code; };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () => resolve(c);
    c.send = o => ws.send(JSON.stringify(o));
    c.wait = async (pred, ms) => { const end = Date.now() + (ms || 1500); for (;;) { const i = c.msgs.findIndex(pred); if (i >= 0) return c.msgs.splice(i, 1)[0]; if (Date.now() > end) throw new Error('timeout waiting; got ' + JSON.stringify(c.msgs.slice(-4))); await sleep(10); } };
    c.none = async (pred, ms) => { await sleep(ms || 150); const m = c.msgs.find(pred); if (m) throw new Error('unexpected ' + JSON.stringify(m)); };
  });
}
function rawUpgrade(port, headers) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = Object.assign({ Host: '127.0.0.1:' + port, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'), 'Sec-WebSocket-Version': '13' }, headers || {});
      s.write('GET / HTTP/1.1\r\n' + Object.keys(h).map(k => k + ': ' + h[k]).join('\r\n') + '\r\n\r\n');
    });
    s.once('data', d => { resolve({ status: parseInt(String(d).split(' ')[1], 10), sock: s }); });
    s.on('error', () => resolve({ status: 0 }));
  });
}
const get = (port, p) => new Promise((res, rej) => http.get({ port, host: '127.0.0.1', path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

(async () => {
  console.log('Last Bell server tests');
  const S = await startServer({ HOST_STALL_MS: '1500', MAX_CONN_PER_IP: '40' });
  const P = S.port;
  try {
    await t('health endpoint', async () => { const r = await get(P, '/health'); assert.strictEqual(r.status, 200); const j = JSON.parse(r.body); assert.ok(j.ok); assert.strictEqual(j.rooms, 0); });

    let A, B, C, D, E, code;
    await t('create room -> joined (host, slot 0, 4 letter code)', async () => {
      A = await client(P); A.send({ t: 'create', v: 1, name: 'Anna' });
      const j = await A.wait(m => m.t === 'joined'); code = j.room;
      assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/); assert.strictEqual(j.you, 1); assert.strictEqual(j.host, 1); assert.strictEqual(j.players.length, 1); assert.strictEqual(j.players[0].slot, 0); assert.strictEqual(j.max, 4);
    });
    await t('join with lowercase code, others get pjoin, slots are distinct', async () => {
      B = await client(P); B.send({ t: 'join', v: 1, room: code.toLowerCase(), name: 'Ben' });
      const j = await B.wait(m => m.t === 'joined'); assert.strictEqual(j.you, 2); assert.strictEqual(j.host, 1); assert.strictEqual(j.players.length, 2);
      const pj = await A.wait(m => m.t === 'pjoin'); assert.strictEqual(pj.p.name, 'Ben'); assert.strictEqual(pj.p.slot, 1);
    });
    await t('names are sanitised', async () => {
      C = await client(P); C.send({ t: 'join', v: 1, room: code, name: '<b>Cl"ara</b>   \u0007 sehr langer name der nicht passt' });
      const j = await C.wait(m => m.t === 'joined'); const me = j.players.find(p => p.id === j.you); assert.ok(!/[<>"]/.test(me.name)); assert.ok(me.name.length <= 20);
    });
    await t('room full -> err full (max 4)', async () => {
      D = await client(P); D.send({ t: 'join', v: 1, room: code, name: 'Dora' }); await D.wait(m => m.t === 'joined');
      E = await client(P); E.send({ t: 'join', v: 1, room: code, name: 'Emil' }); const e = await E.wait(m => m.t === 'err'); assert.strictEqual(e.code, 'full');
    });
    await t('unknown room -> err nofound; wrong protocol -> err version', async () => {
      E.send({ t: 'join', v: 1, room: 'ZZZZ', name: 'x' }); assert.strictEqual((await E.wait(m => m.t === 'err')).code, 'nofound');
      E.send({ t: 'join', v: 99, room: code, name: 'x' }); assert.strictEqual((await E.wait(m => m.t === 'err')).code, 'version');
    });
    await t('broadcast relays to everyone but the sender, with "from"', async () => {
      for (const c of [A, B, C, D]) c.msgs.length = 0;
      A.send({ t: 'b', d: { k: 's', x: 1.5 } });
      for (const c of [B, C, D]) { const m = await c.wait(x => x.t === 'b'); assert.strictEqual(m.from, 1); assert.strictEqual(m.d.x, 1.5); }
      await A.none(x => x.t === 'b');
    });
    await t('direct message only reaches its target', async () => {
      for (const c of [A, B, C, D]) c.msgs.length = 0;
      B.send({ t: 'to', to: 3, d: { k: 'sig', sdp: 'x' } });
      const m = await C.wait(x => x.t === 'to'); assert.strictEqual(m.from, 2); assert.strictEqual(m.d.sdp, 'x');
      await A.none(x => x.t === 'to'); await D.none(x => x.t === 'to'); await B.none(x => x.t === 'to');
    });
    await t('info (voice flags) is broadcast to all including the sender', async () => {
      for (const c of [A, B, C, D]) c.msgs.length = 0;
      B.send({ t: 'info', voice: true, mic: false });
      for (const c of [A, B, C, D]) { const m = await c.wait(x => x.t === 'pinfo'); assert.strictEqual(m.id, 2); assert.strictEqual(m.voice, true); assert.strictEqual(m.mic, false); }
    });
    await t('cfg: only the host may change it; values are validated', async () => {
      for (const c of [A, B, C, D]) c.msgs.length = 0;
      B.send({ t: 'cfg', cfg: { day: 4 } }); await A.none(x => x.t === 'cfg', 200);
      A.send({ t: 'cfg', cfg: { day: 4, diff: 2, state: 'lobby', round: 1 } });
      for (const c of [A, B, C, D]) { const m = await c.wait(x => x.t === 'cfg'); assert.strictEqual(m.cfg.day, 4); assert.strictEqual(m.cfg.diff, 2); }
      A.send({ t: 'cfg', cfg: { day: 99, diff: -3, state: 'hack' } }); const m2 = await B.wait(x => x.t === 'cfg'); assert.strictEqual(m2.cfg.day, 4); assert.strictEqual(m2.cfg.diff, 2); assert.strictEqual(m2.cfg.state, 'lobby');
    });
    await t('kick: only the host, target is told and removed', async () => {
      for (const c of [A, B, C, D]) c.msgs.length = 0;
      B.send({ t: 'kick', id: 4 }); await D.none(x => x.t === 'kicked', 200);
      A.send({ t: 'kick', id: 4 }); await D.wait(x => x.t === 'kicked'); const pl = await A.wait(x => x.t === 'pleave'); assert.strictEqual(pl.id, 4); assert.strictEqual(pl.why, 'kicked');
    });
    await t('late joiner receives the current cfg and a free slot is reused', async () => {
      E.send({ t: 'join', v: 1, room: code, name: 'Emil' }); const j = await E.wait(m => m.t === 'joined'); assert.strictEqual(j.cfg.day, 4); assert.strictEqual(j.players.find(p => p.id === j.you).slot, 3);
    });
    await t('host leaves -> oldest remaining player becomes host', async () => {
      for (const c of [B, C, E]) c.msgs.length = 0;
      A.ws.close(); const pl = await B.wait(x => x.t === 'pleave'); assert.strictEqual(pl.id, 1); assert.strictEqual(pl.host, 2);
    });
    await t('host watchdog: silent host during a round is replaced', async () => {
      B.send({ t: 'cfg', cfg: { state: 'play' } }); await C.wait(x => x.t === 'cfg' && x.cfg.state === 'play');
      for (const c of [B, C, E]) c.msgs.length = 0;
      const h = await C.wait(x => x.t === 'host', 4000); assert.strictEqual(h.id, 3); assert.strictEqual(h.why, 'stalled');
    });
    await t('a host that keeps sending is not replaced', async () => {
      C.send({ t: 'cfg', cfg: { state: 'play' } }); for (const c of [B, C, E]) c.msgs.length = 0;
      for (let i = 0; i < 6; i++) { C.send({ t: 'b', d: { k: 'w' } }); await sleep(400); }
      await B.none(x => x.t === 'host', 50);
    });
    await t('malformed input is ignored, oversized frames close the connection', async () => {
      B.ws.send('not json'); B.ws.send(JSON.stringify([1, 2])); B.ws.send(JSON.stringify({ t: 5 })); B.ws.send(JSON.stringify({ t: 'b' }));
      B.send({ t: 'ping', ts: 7 }); const p = await B.wait(x => x.t === 'pong'); assert.strictEqual(p.ts, 7);
      E.ws.send('x'.repeat(20000)); await sleep(300); assert.ok(E.closed); assert.strictEqual(E.code, 1009);
    });
    await t('rate limit: a flooding client is dropped, the room keeps working', async () => {
      const F = await client(P); F.send({ t: 'join', v: 1, room: code, name: 'Flo' }); await F.wait(m => m.t === 'joined');
      for (let i = 0; i < 2500; i++) F.send({ t: 'b', d: { i } });
      await sleep(600); assert.ok(F.closed, 'flooder should be closed'); assert.strictEqual(F.code, 1008);
      C.msgs.length = 0; B.send({ t: 'b', d: { ok: 1 } }); await C.wait(x => x.t === 'b' && x.d.ok === 1);
    });
    await t('empty room is deleted', async () => {
      for (const c of [B, C]) c.ws.close(); await sleep(250);
      const j = JSON.parse((await get(P, '/health')).body); assert.strictEqual(j.rooms, 0);
    });
  } finally { S.stop(); }

  const S2 = await startServer({ ALLOWED_ORIGINS: 'https://*.crazygames.com,https://example.org', MAX_CONN_PER_IP: '2' });
  try {
    await t('origin allow-list (wildcard sub domains)', async () => {
      const ok = await rawUpgrade(S2.port, { Origin: 'https://games.crazygames.com' }); assert.strictEqual(ok.status, 101); ok.sock.destroy();
      const ok2 = await rawUpgrade(S2.port, { Origin: 'https://example.org' }); assert.strictEqual(ok2.status, 101); ok2.sock.destroy();
      const bad = await rawUpgrade(S2.port, { Origin: 'https://evil.example' }); assert.strictEqual(bad.status, 403);
      const sneaky = await rawUpgrade(S2.port, { Origin: 'https://crazygames.com.evil.example' }); assert.strictEqual(sneaky.status, 403);
      const none = await rawUpgrade(S2.port, {}); assert.strictEqual(none.status, 403);
    });
    await sleep(200);
    await t('per-IP connection limit', async () => {
      const a = await rawUpgrade(S2.port, { Origin: 'https://example.org' }), b = await rawUpgrade(S2.port, { Origin: 'https://example.org' }), c = await rawUpgrade(S2.port, { Origin: 'https://example.org' });
      assert.strictEqual(a.status, 101); assert.strictEqual(b.status, 101); assert.strictEqual(c.status, 429); a.sock.destroy(); b.sock.destroy();
    });
    await t('plain http upgrade without websocket headers is refused', async () => { const r = await rawUpgrade(S2.port, { Upgrade: 'h2c', Origin: 'https://example.org' }); assert.strictEqual(r.status, 400); });
  } finally { S2.stop(); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
