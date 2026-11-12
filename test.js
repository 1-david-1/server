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

  // ================================================================== lobby chat (moderation is decided by the server)
  const mk = async (port, name, code) => { const c = await client(port); c.send(code ? { t: 'join', v: 1, room: code, name } : { t: 'create', v: 1, name }); c.joined = await c.wait(m => m.t === 'joined'); c.id = c.joined.you; return c; };
  const chatsOf = c => c.msgs.filter(m => m.t === 'chat');
  const F = require('./chatfilter.js').create({});

  await t('chat filter: clean text passes, real words with a blocked root are not hit (Marsch, class, Scunthorpe ...)', async () => {
    for (const s of ['Hallo zusammen!', 'Marsch, Marsch!', 'Das Klassenzimmer ist links', 'Spaß ohne Ende', 'cockpit and glass', 'Scunthorpe', 'Assistent bitte', 'Ich bin 12 und du?', 'gg wp noob', 'Lass uns Tag 3 spielen']) {
      const r = F.check(s); assert.ok(r.ok && !r.masked && r.text === s, s + ' -> ' + JSON.stringify(r));
    }
    for (const a of ['Mutiger', 'Flinker', 'Leiser', 'Cooler', 'Kluger', 'Wilder', 'Schlauer', 'Sanfter']) for (const b of ['Fuchs', 'Dachs', 'Luchs', 'Panda', 'Falke', 'Otter', 'Igel', 'Hase']) assert.ok(F.isCleanName(a + ' ' + b + ' 42'), a + ' ' + b);   // every generated player name is clean
  });
  await t('chat filter: profanity is masked in all the usual disguises', async () => {
    const cases = { 'du Arschloch': 'du ***', 'fuck you': '*** you', 'FUUUUCK': '***', 'f u c k': '* * * *', 'f.u.c.k this': '*.*.*.* this', 'sch31sse': '***', '$hit happens': '*** happens', 'what the shіt': 'what the ***', 'Ｆｕｃｋ': '***', 'Verpiss dich': '*** dich', 'ASS': '***', 'a55 hole': '*** hole' };
    for (const k of Object.keys(cases)) { const r = F.check(k); assert.ok(r.ok && r.masked, k + ' -> ' + JSON.stringify(r)); assert.strictEqual(r.text, cases[k], k); }
  });
  await t('chat filter: hate / bullying and contact data are dropped', async () => {
    for (const s of ['kill yourself', 'K Y S', 'geh sterben', 'bring dich um', 'Sieg Heil', 'h e i l   h i t l e r', 'du Schwuchtel', 'send nudes']) assert.deepStrictEqual([s, F.check(s).reason], [s, 'severe']);
    for (const s of ['www.evil.com', 'schau auf evil.de', 'bob@example.com', 'bob (at) example.com', 'ruf mich an 0176 1234567', '@kevin123', 'add me on Discord', 'snapchat?']) assert.deepStrictEqual([s, F.check(s).reason], [s, 'contact']);
    assert.strictEqual(F.check('   ').reason, 'empty');
  });
  await t('chat filter: shouting, stretched letters, control and bidi characters', async () => {
    assert.strictEqual(F.check('LOS GEHT ES JETZT ENDLICH LOS').text, 'Los geht es jetzt endlich los'); assert.strictEqual(F.check('hallooooooooooooo!!!!!!!!!').text, 'hallooo!!!');
    assert.strictEqual(F.check('\u202eevil\u202c \u0007text').text, 'evil text'); assert.ok(F.check('a'.repeat(500)).text.length <= 3);
    assert.ok(Array.from(F.check('wort '.repeat(80)).text).length <= 120);
  });
  await t('chat filter: names, no false alarm for a CrazyGames user name with digits', async () => { assert.ok(F.isCleanName('xX_Pro_1234567')); assert.ok(!F.isCleanName('Arschloch99')); assert.ok(!F.isCleanName('f u c k')); });

  const S3 = await startServer({ CHAT_MIN_GAP_MS: '60', CHAT_IP_PENALTY_MS: '0' });
  try {
    let A, B, C, code;
    await t('chat: joined carries the room chat mode, players carry cm (muted flag)', async () => {
      A = await mk(S3.port, 'Anna'); code = A.joined.room; assert.strictEqual(A.joined.chat, 'text'); assert.strictEqual(A.joined.players[0].cm, 0);
      B = await mk(S3.port, 'Ben', code); C = await mk(S3.port, 'Cleo', code); assert.ok(B.joined.players.every(p => p.cm === 0));
      assert.strictEqual(JSON.parse((await get(S3.port, '/health')).body).chat, true);
    });
    await t('chat: a text message reaches everybody (the sender too), cleaned up, with the sender id', async () => {
      A.send({ t: 'chat', text: '  Hallo   zusammen!  ' });
      for (const c of [A, B, C]) { const m = await c.wait(x => x.t === 'chat'); assert.strictEqual(m.from, A.id); assert.strictEqual(m.text, 'Hallo zusammen!'); assert.ok(!m.masked); assert.ok(m.ts > 0); }
    });
    await t('chat: profanity is masked but delivered, hate and contact data are dropped and the sender is told why', async () => {
      await sleep(80); B.send({ t: 'chat', text: 'du Arschloch' });
      const m = await A.wait(x => x.t === 'chat'); assert.strictEqual(m.text, 'du ***'); assert.strictEqual(m.masked, 1);
      await sleep(80); C.send({ t: 'chat', text: 'ruf mich an 0176 1234567' }); assert.strictEqual((await C.wait(x => x.t === 'cerr')).code, 'contact');
      await sleep(80); A.send({ t: 'chat', text: 'kill yourself' }); assert.strictEqual((await A.wait(x => x.t === 'cerr')).code, 'severe');
      await sleep(150); for (const c of [A, B, C]) assert.ok(!chatsOf(c).some(x => /0176|kill/.test(x.text || '')), 'blocked text leaked');
    });
    await t('chat: malformed chat messages are ignored (no crash, nothing delivered)', async () => {
      A.msgs.length = B.msgs.length = C.msgs.length = 0; await sleep(80); for (const bad of [{ t: 'chat' }, { t: 'chat', text: 42 }, { t: 'chat', text: {} }, { t: 'chat', text: '   ' }, { t: 'chat', q: -1 }, { t: 'chat', q: 1.5 }, { t: 'chat', q: 99 }, { t: 'chat', q: 'x' }]) B.send(bad);
      await sleep(200); for (const c of [A, B, C]) assert.strictEqual(chatsOf(c).length, 0, JSON.stringify(chatsOf(c))); A.msgs.length = B.msgs.length = C.msgs.length = 0;
      B.send({ t: 'ping', ts: 1 }); await B.wait(x => x.t === 'pong');
    });
    await t('chat: the same message twice in a row is refused (dup), another one is fine', async () => {
      await sleep(80); A.send({ t: 'chat', text: 'Wer startet?' }); await B.wait(x => x.t === 'chat');
      await sleep(80); A.send({ t: 'chat', text: 'wer  STARTET ?!' }); assert.strictEqual((await A.wait(x => x.t === 'cerr')).code, 'dup');
      await sleep(80); A.send({ t: 'chat', text: 'Ich nehme Montag' }); assert.strictEqual((await B.wait(x => x.t === 'chat' && x.text === 'Ich nehme Montag')).from, A.id);
    });
    await t('chat: quick phrases (index only) are delivered, out-of-range indexes are not', async () => {
      await sleep(80); B.send({ t: 'chat', q: 3 }); for (const c of [A, B, C]) { const m = await c.wait(x => x.t === 'chat' && x.q === 3); assert.strictEqual(m.from, B.id); assert.strictEqual(m.text, undefined); }
    });
    await t('chat: a player who switches chat off neither sends nor receives, the others keep talking', async () => {
      C.send({ t: 'cset', on: false }); await sleep(80); A.msgs.length = B.msgs.length = C.msgs.length = 0;
      A.send({ t: 'chat', text: 'Nur fuer euch zwei' }); await B.wait(x => x.t === 'chat'); await sleep(120); assert.strictEqual(chatsOf(C).length, 0);
      await sleep(80); C.send({ t: 'chat', text: 'Hallo?' }); assert.strictEqual((await C.wait(x => x.t === 'cerr')).code, 'chatoff');
      C.send({ t: 'cset', on: true }); await sleep(80); A.send({ t: 'chat', text: 'Wieder da?' }); await C.wait(x => x.t === 'chat' && x.text === 'Wieder da?');
    });
    await t('chat: block - messages of a blocked player never reach the blocker (decided by the server), the rest of the room still gets them', async () => {
      B.send({ t: 'cblock', id: C.id, on: true }); await sleep(80); A.msgs.length = B.msgs.length = C.msgs.length = 0;
      C.send({ t: 'chat', text: 'Sag mal B' }); await A.wait(x => x.t === 'chat' && x.text === 'Sag mal B'); await C.wait(x => x.t === 'chat'); await sleep(120); assert.strictEqual(chatsOf(B).length, 0);
      B.send({ t: 'cblock', id: C.id, on: false }); await sleep(150); C.send({ t: 'chat', text: 'Und jetzt?' }); await B.wait(x => x.t === 'chat' && x.text === 'Und jetzt?');
    });
    await t('chat: host mute - only the host, the room sees the mute flag, the muted player is told', async () => {
      C.send({ t: 'cmute', id: B.id, on: true }); await sleep(120); assert.ok(!A.msgs.some(m => m.t === 'cstate'), 'a guest muted somebody');
      A.send({ t: 'cmute', id: B.id, on: true }); for (const c of [A, B, C]) { const m = await c.wait(x => x.t === 'cstate' && x.id === B.id); assert.strictEqual(m.cm, 1); assert.strictEqual(m.hm, 1); }
      await sleep(80); B.send({ t: 'chat', text: 'Hallo' }); assert.strictEqual((await B.wait(x => x.t === 'cerr')).code, 'hostmuted');
      B.send({ t: 'chat', q: 0 }); assert.strictEqual((await B.wait(x => x.t === 'cerr')).code, 'hostmuted');
      A.send({ t: 'cmute', id: A.id, on: true }); await sleep(100); assert.ok(!B.msgs.some(m => m.t === 'cstate' && m.id === A.id));          // the host cannot mute himself
      A.send({ t: 'cmute', id: B.id, on: false }); for (const c of [A, B, C]) assert.strictEqual((await c.wait(x => x.t === 'cstate' && x.id === B.id)).cm, 0);
      await sleep(80); B.send({ t: 'chat', text: 'Danke' }); await A.wait(x => x.t === 'chat' && x.text === 'Danke');
    });
    await t('chat: modes - only the host switches them; quick = phrases only, off = nothing; late joiners get the mode', async () => {
      B.send({ t: 'cmode', mode: 'off' }); await sleep(100); assert.ok(!A.msgs.some(m => m.t === 'cmode'), 'a guest changed the mode');
      A.send({ t: 'cmode', mode: 'bogus' }); await sleep(100); assert.ok(!A.msgs.some(m => m.t === 'cmode'));
      A.send({ t: 'cmode', mode: 'quick' }); for (const c of [A, B, C]) { const m = await c.wait(x => x.t === 'cmode'); assert.strictEqual(m.mode, 'quick'); assert.strictEqual(m.by, A.id); }
      await sleep(80); B.send({ t: 'chat', text: 'Freitext' }); assert.strictEqual((await B.wait(x => x.t === 'cerr')).code, 'quickonly');
      await sleep(80); B.send({ t: 'chat', q: 5 }); await C.wait(x => x.t === 'chat' && x.q === 5);
      A.send({ t: 'cmode', mode: 'off' }); await B.wait(x => x.t === 'cmode' && x.mode === 'off'); await sleep(80);
      B.send({ t: 'chat', q: 5 }); assert.strictEqual((await B.wait(x => x.t === 'cerr')).code, 'off');
      const D = await mk(S3.port, 'Dora', code); assert.strictEqual(D.joined.chat, 'off'); D.ws.close();
      A.send({ t: 'cmode', mode: 'text' }); await C.wait(x => x.t === 'cmode' && x.mode === 'text');
    });
    for (const c of [A, B, C]) c.ws.close(); await sleep(250);

    await t('chat: rate limit - minimum gap and a burst limit per window; spamming is answered with cerr rate', async () => {
      const P = await mk(S3.port, 'Pia'); const Q = await mk(S3.port, 'Quentin', P.joined.room);
      P.send({ t: 'chat', text: 'eins' }); P.send({ t: 'chat', text: 'zwei' }); assert.strictEqual((await P.wait(x => x.t === 'cerr')).code, 'rate'); await Q.wait(x => x.t === 'chat' && x.text === 'eins'); await sleep(150); assert.ok(!chatsOf(Q).some(m => m.text === 'zwei'));
      for (let i = 0; i < 7; i++) { await sleep(90); P.send({ t: 'chat', text: 'nachricht ' + (i + 10) }); }
      await sleep(150); assert.ok(P.msgs.filter(m => m.t === 'cerr' && m.code === 'rate').length >= 1, 'no burst limit'); assert.ok(chatsOf(Q).length <= 6, 'more than the burst limit got through: ' + chatsOf(Q).length);
      P.ws.close(); Q.ws.close(); await sleep(100);
    });
    await t('chat: names go through the word filter on join and on rename', async () => {
      const N1 = await mk(S3.port, 'Arschloch'); assert.strictEqual(N1.joined.players[0].name, 'Spieler');
      const N2 = await mk(S3.port, 'Mutiger Fuchs 42', N1.joined.room); assert.strictEqual(N2.joined.players.find(p => p.id === N2.id).name, 'Mutiger Fuchs 42');
      N2.send({ t: 'info', name: 'f u c k' }); const pi = await N1.wait(x => x.t === 'pinfo' && x.id === N2.id); assert.strictEqual(pi.name, 'Mutiger Fuchs 42');
      N1.ws.close(); N2.ws.close(); await sleep(100);
    });
    await t('chat: reports - two different reporters mute a player for a while, a second report of the same player counts once', async () => {
      const R1 = await mk(S3.port, 'Rita'), R2 = await mk(S3.port, 'Ralf', R1.joined.room), R3 = await mk(S3.port, 'Rudi', R1.joined.room);
      R2.send({ t: 'creport', id: R3.id }); const ack = await R2.wait(x => x.t === 'cack'); assert.strictEqual(ack.id, R3.id);
      R2.send({ t: 'creport', id: R3.id }); R2.send({ t: 'creport', id: R2.id }); R2.send({ t: 'creport', id: 999 }); await sleep(150); assert.ok(!R2.msgs.some(m => m.t === 'cack'), 'duplicate / self / unknown report was acknowledged'); assert.ok(!R3.msgs.some(m => m.t === 'cerr'));
      R1.send({ t: 'creport', id: R3.id }); const e = await R3.wait(x => x.t === 'cerr' && x.code === 'muted'); assert.ok(e.ms > 0);
      for (const c of [R1, R2, R3]) assert.strictEqual((await c.wait(x => x.t === 'cstate' && x.id === R3.id)).cm, 1);
      await sleep(80); R3.send({ t: 'chat', text: 'hallo' }); assert.strictEqual((await R3.wait(x => x.t === 'cerr' && x.code === 'muted')).code, 'muted');
      R1.ws.close(); R2.ws.close(); R3.ws.close(); await sleep(100);
    });
    await t('chat: a muted player who becomes host is unmuted (the host role cannot be muted)', async () => {
      const H1 = await mk(S3.port, 'Hanna'), H2 = await mk(S3.port, 'Hugo', H1.joined.room), H3 = await mk(S3.port, 'Hilde', H1.joined.room);
      H1.send({ t: 'cmute', id: H2.id, on: true }); await H3.wait(x => x.t === 'cstate' && x.id === H2.id && x.cm === 1);
      H1.ws.close(); const m = await H3.wait(x => x.t === 'cstate' && x.id === H2.id && x.cm === 0); assert.strictEqual(m.cm, 0);
      await sleep(80); H2.send({ t: 'chat', text: 'Ich bin jetzt Host' }); await H3.wait(x => x.t === 'chat' && x.text === 'Ich bin jetzt Host');
      H2.ws.close(); H3.ws.close(); await sleep(100);
    });
    await t('chat: messages never cross into another room', async () => {
      const X1 = await mk(S3.port, 'Xaver'), Y1 = await mk(S3.port, 'Yvonne'); X1.send({ t: 'chat', text: 'geheim' }); await X1.wait(x => x.t === 'chat'); await sleep(150); assert.strictEqual(chatsOf(Y1).length, 0);
      X1.ws.close(); Y1.ws.close(); await sleep(100);
    });
  } finally { S3.stop(); }

  const S4 = await startServer({ CHAT_MIN_GAP_MS: '20', CHAT_STRIKES: '2', CHAT_MUTE1_MS: '250', CHAT_MUTE2_MS: '250', CHAT_IP_PENALTY_MS: '3000' });
  try {
    await t('chat strikes: hate speech mutes at once (here 2 points), the mute ends by itself and the room is told, repeat offenders get longer mutes, the third one lasts for the stay', async () => {
      const X = await mk(S4.port, 'Xenia'), Y = await mk(S4.port, 'Yusuf', X.joined.room), Z = await mk(S4.port, 'Zoe', X.joined.room);
      Y.send({ t: 'chat', text: 'kill yourself' }); const mu = await Y.wait(x => x.t === 'cerr' && x.code === 'muted'); assert.strictEqual(mu.ms, 250); await Y.wait(x => x.t === 'cerr' && x.code === 'severe');
      for (const c of [X, Y, Z]) assert.strictEqual((await c.wait(x => x.t === 'cstate' && x.id === Y.id)).cm, 1);
      Y.send({ t: 'chat', text: 'hallo' }); assert.strictEqual((await Y.wait(x => x.t === 'cerr' && x.code === 'muted')).code, 'muted');
      await sleep(300); Y.send({ t: 'chat', text: 'wieder da' }); await Z.wait(x => x.t === 'chat' && x.text === 'wieder da');
      await Z.wait(x => x.t === 'cstate' && x.id === Y.id && x.cm === 0, 3500);                                  // the room is told when the mute is over (checked every 2 s)
      await sleep(40); Y.send({ t: 'chat', text: 'du Schwuchtel' }); assert.strictEqual((await Y.wait(x => x.t === 'cerr' && x.code === 'muted')).ms, 250);
      await sleep(300); Y.send({ t: 'chat', text: 'kill yourself' }); assert.strictEqual((await Y.wait(x => x.t === 'cerr' && x.code === 'muted')).ms, -1);
      await sleep(300); Y.send({ t: 'chat', text: 'bin ich noch stumm' }); assert.strictEqual((await Y.wait(x => x.t === 'cerr' && x.code === 'muted')).ms, -1);
      Y.ws.close(); await sleep(150);
      const Y2 = await mk(S4.port, 'Yusuf', X.joined.room); assert.strictEqual(Y2.joined.players.find(p => p.id === Y2.id).cm, 1);                         // rejoining does not help (same address)
      Y2.send({ t: 'chat', text: 'neuer Versuch' }); assert.strictEqual((await Y2.wait(x => x.t === 'cerr' && x.code === 'muted')).ms, -1);
      for (const c of [X, Y2, Z]) c.ws.close(); await sleep(100);
    });
    await t('chat strikes: mild words are only masked and never lead to a mute', async () => {
      const M1 = await mk(S4.port, 'Mara'), M2 = await mk(S4.port, 'Moritz', M1.joined.room); await sleep(3200);       // let the address penalty of the test before run out
      const M3 = await mk(S4.port, 'Mona', M1.joined.room);
      for (let i = 0; i < 4; i++) { await sleep(40); M3.send({ t: 'chat', text: 'du Trottel ' + i }); const m = await M2.wait(x => x.t === 'chat' && /Trottel|\*/.test(x.text)); assert.ok(/\*\*\*/.test(m.text)); }
      assert.ok(!M3.msgs.some(m => m.t === 'cerr' && m.code === 'muted'));
      for (const c of [M1, M2, M3]) c.ws.close(); await sleep(100);
    });
  } finally { S4.stop(); }

  const S5 = await startServer({ CHAT_DEFAULT: 'quick' });
  try {
    await t('chat: CHAT_DEFAULT=quick starts new rooms with quick phrases only', async () => {
      const Q1 = await mk(S5.port, 'Quick'); assert.strictEqual(Q1.joined.chat, 'quick'); await sleep(900); Q1.send({ t: 'chat', text: 'frei' }); assert.strictEqual((await Q1.wait(x => x.t === 'cerr')).code, 'quickonly');
      await sleep(900); Q1.send({ t: 'chat', q: 0 }); await Q1.wait(x => x.t === 'chat' && x.q === 0); Q1.ws.close(); await sleep(100);
    });
  } finally { S5.stop(); }

  const S6 = await startServer({ CHAT: '0' });
  try {
    await t('chat: CHAT=0 switches the whole chat off (no chat field, nothing is relayed, health says so)', async () => {
      const O1 = await mk(S6.port, 'Olli'), O2 = await mk(S6.port, 'Olga', O1.joined.room); assert.strictEqual(O1.joined.chat, undefined);
      O1.send({ t: 'chat', text: 'hallo' }); O1.send({ t: 'chat', q: 1 }); O1.send({ t: 'cmode', mode: 'text' }); await sleep(250); for (const c of [O1, O2]) assert.ok(!c.msgs.some(m => m.t === 'chat' || m.t === 'cmode' || m.t === 'cerr'));
      assert.strictEqual(JSON.parse((await get(S6.port, '/health')).body).chat, false); O1.ws.close(); O2.ws.close(); await sleep(100);
    });
  } finally { S6.stop(); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
