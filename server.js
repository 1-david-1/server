#!/usr/bin/env node
'use strict';
/* Last Bell - multiplayer relay server.
 *
 * - No dependencies: plain Node (>= 18) with its own RFC 6455 WebSocket implementation.
 * - It does NOT simulate the game. One player of a room (the host) runs the teacher AI in his browser and the
 *   server only relays messages between the players of a room, hands out room codes and relays the WebRTC
 *   signalling of the voice chat. It also watches the host: if he stops sending while a round runs (hidden
 *   browser tab, frozen game) another player becomes host.
 * - Put it behind TLS (wss://). CrazyGames pages are https, browsers block plain ws:// from them.
 *
 * Environment: PORT (8080), MAX_PLAYERS (4), ALLOWED_ORIGINS ("*" or e.g. "https://*.crazygames.com,https://my.site"),
 *              MAX_ROOMS (5000), MAX_CONN_PER_IP (30), TRUST_PROXY (1 = use X-Forwarded-For; set it behind Render/Fly/Caddy/nginx, otherwise every player looks like the proxy's IP), HOST_STALL_MS (6000),
 *              RATE_PER_SEC (80), RATE_BURST (200), DEBUG (1)
 * Lobby chat (all moderation runs HERE, a modified client cannot get around it - see chatfilter.js):
 *              CHAT (0 = no chat at all), CHAT_DEFAULT (text | quick | off: mode of a new room, the host can change it), CHAT_MAX_LEN (120), CHAT_MIN_GAP_MS (800), CHAT_BURST (6 messages per CHAT_WINDOW_MS 10000),
 *              CHAT_STRIKES (4 points -> muted; mild words 0, profanity 1, hate 2, links/contact data 1, spam 0.25; 1 point fades per CHAT_STRIKE_DECAY_MS 60000), CHAT_MUTE1_MS (60000), CHAT_MUTE2_MS (180000), the 3rd mute lasts for the rest of the stay,
 *              CHAT_IP_PENALTY_MS (900000: a player muted for good stays muted for this long if he rejoins; 0 = off), CHAT_REPORTS_TO_MUTE (2 different reporters), CHAT_REPORT_MUTE_MS (300000),
 *              CHAT_EXTRA_WORDS / CHAT_ALLOW_WORDS (comma separated), CHAT_BLOCK_CONTACTS (0 = allow links / phone numbers / messenger names)
 */
const http = require('http');
const crypto = require('crypto');
const chatFilter = require('./chatfilter.js').fromEnv();

const PROTO = 1;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const CFG = {
  port: num(process.env.PORT, 8080),
  maxPlayers: Math.min(8, Math.max(2, num(process.env.MAX_PLAYERS, 4))),
  maxRooms: num(process.env.MAX_ROOMS, 5000),
  maxConnPerIp: num(process.env.MAX_CONN_PER_IP, 30),
  maxMsg: 16 * 1024,
  trustProxy: process.env.TRUST_PROXY === '1',
  hostStallMs: num(process.env.HOST_STALL_MS, 6000),
  rate: num(process.env.RATE_PER_SEC, 80),
  burst: num(process.env.RATE_BURST, 200),
  debug: process.env.DEBUG === '1',
  chatEnabled: process.env.CHAT !== '0',
  chatDefault: ['text', 'quick', 'off'].includes(process.env.CHAT_DEFAULT) ? process.env.CHAT_DEFAULT : 'text',
  chatGap: num(process.env.CHAT_MIN_GAP_MS, 800),
  chatBurst: num(process.env.CHAT_BURST, 6),
  chatWindow: num(process.env.CHAT_WINDOW_MS, 10000),
  chatDupMs: num(process.env.CHAT_DUP_MS, 15000),
  strikeLimit: num(process.env.CHAT_STRIKES, 4),
  strikeDecayMs: num(process.env.CHAT_STRIKE_DECAY_MS, 60000),
  muteMs: [num(process.env.CHAT_MUTE1_MS, 60000), num(process.env.CHAT_MUTE2_MS, 180000)],
  penaltyMs: process.env.CHAT_IP_PENALTY_MS === '0' ? 0 : num(process.env.CHAT_IP_PENALTY_MS, 900000),
  reportsToMute: num(process.env.CHAT_REPORTS_TO_MUTE, 2),
  reportMuteMs: num(process.env.CHAT_REPORT_MUTE_MS, 300000),
  origins: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean),
};
const originRes = CFG.origins.map(o => (o === '*' ? null : new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+(?:\\.[^.]+)*') + '$', 'i')));
const originOk = o => CFG.origins.includes('*') || (!!o && originRes.some(r => r && r.test(o)));
const log = (...a) => { if (CFG.debug) console.log(new Date().toISOString(), ...a); };

const rooms = new Map();           // code -> room
const ipCount = new Map();         // ip -> open connections
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1
const stats = { started: Date.now(), conns: 0, roomsCreated: 0, messages: 0 };
const penalties = new Map();       // ip -> time until which a player who was muted for good stays muted if he rejoins

// ------------------------------------------------------------------ websocket framing
function frame(op, payload) {
  const len = payload.length; let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | op; return Buffer.concat([h, payload]);
}
const frameText = s => frame(0x1, Buffer.from(s, 'utf8'));

class Conn {
  constructor(sock, ip) {
    this.sock = sock; this.ip = ip; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false; this.alive = true;
    this.tokens = CFG.burst; this.lastRefill = Date.now(); this.drops = 0; this.player = null; this.room = null;
  }
  raw(buf) { if (!this.closed && this.sock.writable) { try { this.sock.write(buf); } catch (e) { /* socket gone */ } } }
  send(obj) { this.raw(frameText(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close(code, reason) {
    if (this.closed) return;
    let f = null; try { const r = Buffer.from(String(reason || '').slice(0, 100)); const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2); f = frame(0x8, p); } catch (e) { /* ignore */ }
    this.closed = true;                                                           // flush the close frame first (end), destroy only as a fallback
    try { if (f) this.sock.end(f); else this.sock.destroy(); } catch (e) { /* ignore */ }
    const s = this.sock; setTimeout(() => { try { s.destroy(); } catch (e) { /* ignore */ } }, 1000).unref();
    onClose(this);
  }
  destroy() { if (this.closed) return; this.closed = true; try { this.sock.destroy(); } catch (e) { /* ignore */ } onClose(this); }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf; if (this.closed || b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80); let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(CFG.maxMsg)) return this.close(1009, 'too big'); len = Number(big); off = 10; }
      if (len > CFG.maxMsg) return this.close(1009, 'too big');
      if (!masked) return this.close(1002, 'unmasked frame');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) return this.close(1000, 'bye');
      if (op === 0x9) { this.raw(frame(0xA, data)); continue; }
      if (op === 0xA) { this.alive = true; continue; }
      if (op === 0x1 || op === 0x2) { if (!fin) { this.frag = { op, parts: [data], size: data.length }; continue; } this.message(op, data); }
      else if (op === 0x0) {
        if (!this.frag) return this.close(1002, 'bad continuation');
        this.frag.parts.push(data); this.frag.size += data.length; if (this.frag.size > CFG.maxMsg) return this.close(1009, 'too big');
        if (fin) { const f = this.frag; this.frag = null; this.message(f.op, Buffer.concat(f.parts)); }
      } else return this.close(1002, 'bad opcode');
    }
  }
  message(op, data) {
    if (op !== 0x1) return;                                                       // text frames only
    const now = Date.now(); this.tokens = Math.min(CFG.burst, this.tokens + (now - this.lastRefill) / 1000 * CFG.rate); this.lastRefill = now;
    if (this.tokens < 1) { if (++this.drops > 300) this.close(1008, 'rate limit'); return; }
    this.tokens -= 1; stats.messages++;
    let m; try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { handle(this, m); } catch (e) { console.error('handler error', e); }
  }
}

// ------------------------------------------------------------------ helpers
const clean = (s, d) => { s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20); return s || d; };
function newCode() { for (let k = 0; k < 50; k++) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } return null; }
const pub = p => ({ id: p.id, name: p.name, slot: p.slot, voice: !!p.voice, mic: !!p.mic, ready: !!p.ready, cg: !!p.cg, cm: isMuted(p) ? 1 : 0, hm: p.hostMuted ? 1 : 0 });
function pickHost(room) { let best = null; for (const q of room.players.values()) if (!best || q.joined < best.joined) best = q; return best ? best.id : 0; }
function sendTo(room, id, obj) { const p = room.players.get(id); if (p) p.conn.send(obj); }
function broadcast(room, obj, exceptId) { const f = frameText(JSON.stringify(obj)); for (const p of room.players.values()) if (p.id !== exceptId) p.conn.raw(f); }
function freeSlot(room) { const used = new Set([...room.players.values()].map(p => p.slot)); for (let i = 0; i < room.max; i++) if (!used.has(i)) return i; return -1; }
const roomState = room => ({ v: PROTO, room: room.code, host: room.hostId, max: room.max, cfg: room.cfg, open: room.open, chat: CFG.chatEnabled ? room.chat : undefined, players: [...room.players.values()].map(pub) });

function addPlayer(conn, room, m) {
  const slot = freeSlot(room), p = Object.assign({ id: room.nextId++, name: safeName(m.name, 'Spieler'), slot, conn, joined: Date.now(), voice: false, mic: false, ready: false, cg: !!m.cg }, newChatState(conn));
  room.players.set(p.id, p); conn.player = p; conn.room = room;
  if (!room.hostId) { room.hostId = p.id; room.lastHostMsg = Date.now(); }
  conn.send(Object.assign({ t: 'joined', you: p.id }, roomState(room)));
  broadcast(room, { t: 'pjoin', p: pub(p) }, p.id);
  log('join', room.code, p.id, p.name, room.players.size + '/' + room.max);
}
function removePlayer(conn, why) {
  const room = conn.room, p = conn.player; if (!room || !p) return;
  conn.room = null; conn.player = null; room.players.delete(p.id);
  if (!room.players.size) { rooms.delete(room.code); log('room closed', room.code); return; }
  let host = room.hostId; if (p.id === room.hostId) { host = room.hostId = pickHost(room); room.lastHostMsg = Date.now(); unmuteHost(room); }
  broadcast(room, { t: 'pleave', id: p.id, host, why: why || 'left' }, null);
  log('leave', room.code, p.id, why || 'left');
}
function onClose(conn) {
  stats.conns--; const n = (ipCount.get(conn.ip) || 1) - 1; if (n <= 0) ipCount.delete(conn.ip); else ipCount.set(conn.ip, n);
  removePlayer(conn, 'disconnect');
}
const err = (conn, code, msg) => conn.send({ t: 'err', code, msg });

// ------------------------------------------------------------------ chat (lobby text chat). ALL moderation is decided here, never in the client.
// Layers: room mode (text / quick phrases only / off, set by the host) -> the player's own switch (CrazyGames "disableChat") -> rate limit -> word / link / contact filter (chatfilter.js)
//         -> strike points that lead to a mute (60 s, 180 s, then for the rest of the stay) -> reports of other players (2 different reporters = 5 min mute) -> host mute -> every player can block another one for himself.
const QUICK_COUNT = 12;                                                         // quick phrases: the texts live in the client (so they are shown in the reader's language), the server only checks the index
const FOREVER = Number.MAX_SAFE_INTEGER;
function isMuted(p, t) { return !!p.hostMuted || p.until > (t || Date.now()); }
const cerr = (conn, code, ms) => conn.send({ t: 'cerr', code, ms });
const evlog = o => console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString() }, o)));
function newChatState(conn) {
  const pen = penalties.get(conn.ip), t = Date.now();
  return { chatOff: false, hostMuted: false, until: pen && pen > t ? FOREVER : 0, muteSent: false, points: 0, pointsAt: t, mutes: 0, lastMsgAt: 0, times: [], lastNorm: '', lastNormAt: 0, blocked: new Set(), reportedBy: new Set() };
}
const safeName = (s, d) => { const n = clean(s, d); return chatFilter.isCleanName(n) ? n : d; };      // names go through the word filter as well (CrazyGames user names, modified clients)
function chatState(room, p) { p.muteSent = isMuted(p); broadcast(room, { t: 'cstate', id: p.id, cm: p.muteSent ? 1 : 0, hm: p.hostMuted ? 1 : 0 }, null); }
function unmuteHost(room) { const h = room.players.get(room.hostId); if (h && h.hostMuted) { h.hostMuted = false; chatState(room, h); } }
/** violation points (they fade: 1 point per CHAT_STRIKE_DECAY_MS). Enough of them -> the player is muted, each time for longer. */
function strike(room, p, pts, why) {
  const t = Date.now(); p.points = Math.max(0, p.points - (t - p.pointsAt) / CFG.strikeDecayMs) + pts; p.pointsAt = t;
  if (p.points < CFG.strikeLimit) return;
  p.points = 0; p.mutes++;
  const ms = p.mutes <= CFG.muteMs.length ? CFG.muteMs[p.mutes - 1] : 0;       // 0 = for the rest of his stay
  p.until = ms ? t + ms : FOREVER; if (!ms && CFG.penaltyMs) penalties.set(p.conn.ip, t + CFG.penaltyMs);
  cerr(p.conn, 'muted', ms || -1); chatState(room, p);
  evlog({ ev: 'chat-mute', room: room.code, player: p.id, name: p.name, why, ms: ms || -1 });
}
function deliver(room, me, body) {
  const t = Date.now(), msg = Object.assign({ t: 'chat', from: me.id, ts: t }, body), f = frameText(JSON.stringify(msg));
  room.log.push({ from: me.id, name: me.name, ts: t, text: body.text !== undefined ? body.text : '#quick' + body.q }); if (room.log.length > 40) room.log.shift();     // kept in memory only, for reports; gone when the room closes
  for (const p of room.players.values()) { if (p.chatOff) continue; if (p.id !== me.id && p.blocked.has(me.id)) continue; p.conn.raw(f); }
}
function onChat(room, me, m) {
  if (!CFG.chatEnabled) return;
  const conn = me.conn, t = Date.now();
  if (room.chat === 'off') return cerr(conn, 'off');
  if (me.chatOff) return cerr(conn, 'chatoff');
  if (me.hostMuted) return cerr(conn, 'hostmuted');
  if (me.until > t) return cerr(conn, 'muted', me.until === FOREVER ? -1 : me.until - t);
  me.times = me.times.filter(x => t - x < CFG.chatWindow);
  if (t - me.lastMsgAt < CFG.chatGap || me.times.length >= CFG.chatBurst) { strike(room, me, 0.25, 'spam'); return cerr(conn, 'rate'); }
  let body;
  if (m.q !== undefined) {
    if (!Number.isInteger(m.q) || m.q < 0 || m.q >= QUICK_COUNT) return;
    body = { q: m.q };
  } else {
    if (room.chat !== 'text') return cerr(conn, 'quickonly');
    if (typeof m.text !== 'string') return;
    const r = chatFilter.check(m.text);
    if (r.reason === 'empty') return;
    if (!r.ok) { strike(room, me, r.reason === 'severe' ? 2 : 1, r.reason); return cerr(conn, r.reason); }       // 'severe' (hate, bullying) or 'contact' (link, phone number, messenger): the message is dropped
    if (r.norm && r.norm === me.lastNorm && t - me.lastNormAt < CFG.chatDupMs) return cerr(conn, 'dup');
    me.lastNorm = r.norm; me.lastNormAt = t;
    if (r.tier >= 2) strike(room, me, 1, 'profanity');
    body = { text: r.text }; if (r.masked) body.masked = 1;
  }
  me.lastMsgAt = t; me.times.push(t);
  deliver(room, me, body);
}
function onChatAdmin(room, me, m) {
  switch (m.t) {
    case 'cset': me.chatOff = !m.on; return;                                    // the player switched the text chat off for himself (or CrazyGames' disableChat is on): he neither sends nor receives
    case 'cblock': {
      const id = m.id; if (!Number.isInteger(id) || id === me.id) return;
      if (m.on) { if (me.blocked.size < 16) me.blocked.add(id); } else me.blocked.delete(id); return;
    }
    case 'cmode': {
      if (me.id !== room.hostId || !['text', 'quick', 'off'].includes(m.mode) || room.chat === m.mode) return;
      room.chat = m.mode; return broadcast(room, { t: 'cmode', mode: m.mode, by: me.id }, null);
    }
    case 'cmute': {
      const p = room.players.get(m.id); if (me.id !== room.hostId || !p || p.id === me.id) return;
      p.hostMuted = !!m.on; chatState(room, p); return;
    }
    case 'creport': {
      const p = room.players.get(m.id); if (!p || p.id === me.id || p.reportedBy.has(me.id)) return;
      p.reportedBy.add(me.id);
      evlog({ ev: 'chat-report', room: room.code, by: me.id, byName: me.name, target: p.id, targetName: p.name, reports: p.reportedBy.size, last: room.log.filter(x => x.from === p.id).slice(-5).map(x => x.text) });
      if (p.reportedBy.size >= CFG.reportsToMute && !isMuted(p)) { p.until = Date.now() + CFG.reportMuteMs; cerr(p.conn, 'muted', CFG.reportMuteMs); chatState(room, p); }
      return me.conn.send({ t: 'cack', what: 'report', id: p.id });
    }
    default: return;
  }
}

// ------------------------------------------------------------------ protocol
function handle(conn, m) {
  const room = conn.room, me = conn.player;
  switch (m.t) {
    case 'ping': return conn.send({ t: 'pong', ts: m.ts });
    case 'create': {
      if (me) return err(conn, 'busy', 'already in a room');
      if (m.v !== PROTO) return err(conn, 'version', 'protocol ' + PROTO + ' required');
      if (rooms.size >= CFG.maxRooms) return err(conn, 'busy', 'server full');
      const code = newCode(); if (!code) return err(conn, 'busy', 'no code free');
      const r = { code, players: new Map(), hostId: 0, nextId: 1, max: CFG.maxPlayers, open: true, cfg: { day: 0, diff: 1, state: 'lobby', round: 0 }, created: Date.now(), lastHostMsg: Date.now(), chat: CFG.chatDefault, log: [] };
      rooms.set(code, r); stats.roomsCreated++; return addPlayer(conn, r, m);
    }
    case 'join': {
      if (me) return err(conn, 'busy', 'already in a room');
      if (m.v !== PROTO) return err(conn, 'version', 'protocol ' + PROTO + ' required');
      const r = rooms.get(String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (!r) return err(conn, 'nofound', 'room not found');
      if (!r.open) return err(conn, 'closed', 'room closed');
      if (r.players.size >= r.max) return err(conn, 'full', 'room full');
      return addPlayer(conn, r, m);
    }
    case 'leave': return removePlayer(conn, 'left');
    default: break;
  }
  if (!room || !me) return;                                                       // everything below needs a room
  switch (m.t) {
    case 'info': {
      if ('voice' in m) me.voice = !!m.voice; if ('mic' in m) me.mic = !!m.mic; if ('ready' in m) me.ready = !!m.ready; if ('name' in m) me.name = safeName(m.name, me.name);
      return broadcast(room, { t: 'pinfo', id: me.id, name: me.name, voice: me.voice, mic: me.mic, ready: me.ready }, null);
    }
    case 'cfg': {
      if (me.id !== room.hostId || !m.cfg || typeof m.cfg !== 'object') return;
      const c = room.cfg, n = m.cfg;
      if (Number.isInteger(n.day) && n.day >= 0 && n.day < 20) c.day = n.day;
      if (Number.isInteger(n.diff) && n.diff >= 0 && n.diff <= 2) c.diff = n.diff;
      if (n.state === 'lobby' || n.state === 'play' || n.state === 'end') { c.state = n.state; room.lastHostMsg = Date.now(); }
      if (Number.isInteger(n.round) && n.round >= 0) c.round = n.round;
      return broadcast(room, { t: 'cfg', cfg: c }, null);
    }
    case 'open': { if (me.id === room.hostId) room.open = !!m.open; return; }
    case 'kick': {
      if (me.id !== room.hostId || m.id === me.id) return; const p = room.players.get(m.id); if (!p) return;
      p.conn.send({ t: 'kicked' }); removePlayer(p.conn, 'kicked'); return;
    }
    case 'b': {
      if (!m.d || typeof m.d !== 'object') return; if (me.id === room.hostId) room.lastHostMsg = Date.now();
      return broadcast(room, { t: 'b', from: me.id, d: m.d }, me.id);
    }
    case 'to': {
      if (!m.d || typeof m.d !== 'object' || !Number.isInteger(m.to) || m.to === me.id) return;
      return sendTo(room, m.to, { t: 'to', from: me.id, d: m.d });
    }
    case 'chat': return onChat(room, me, m);
    case 'cset': case 'cblock': case 'cmode': case 'cmute': case 'creport': return CFG.chatEnabled ? onChatAdmin(room, me, m) : undefined;
    default: return;
  }
}

// ------------------------------------------------------------------ http + upgrade
const server = http.createServer((req, res) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (req.url === '/health' || req.url.startsWith('/health?')) {
    let players = 0; rooms.forEach(r => { players += r.players.size; });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, h));
    return res.end(JSON.stringify({ ok: true, proto: PROTO, rooms: rooms.size, players, uptime: Math.round((Date.now() - stats.started) / 1000), maxPlayers: CFG.maxPlayers, chat: CFG.chatEnabled }));
  }
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, h)); res.end('Last Bell multiplayer server is running.\n');
});
server.on('upgrade', (req, sock) => {
  const ip = (CFG.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const key = req.headers['sec-websocket-key'], reject = (code, why) => { try { sock.end('HTTP/1.1 ' + code + ' ' + why + '\r\nConnection: close\r\n\r\n'); } catch (e) { /* ignore */ } };
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') return reject(400, 'Bad Request');
  if (!originOk(req.headers.origin)) { log('origin rejected', req.headers.origin); return reject(403, 'Forbidden'); }
  if ((ipCount.get(ip) || 0) >= CFG.maxConnPerIp) return reject(429, 'Too Many Requests');
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true); sock.setTimeout(0);
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1); stats.conns++;
  const conn = new Conn(sock, ip);
  sock.on('data', d => { try { conn.feed(d); } catch (e) { console.error('frame error', e); conn.destroy(); } });
  sock.on('close', () => conn.destroy()); sock.on('error', () => conn.destroy());
  sock.on('end', () => conn.destroy());                                          // http.Server keeps half-open sockets: a tab that just vanishes (FIN) must free its seat at once
});

// keep-alive (proxies close idle sockets) + host watchdog
const timers = [];
timers.push(setInterval(() => {
  rooms.forEach(r => r.players.forEach(p => { const c = p.conn; if (!c.alive) return c.destroy(); c.alive = false; c.raw(frame(0x9, Buffer.alloc(0))); }));
}, 25000));
timers.push(setInterval(() => {
  const now = Date.now();
  rooms.forEach(r => {
    if (r.cfg.state !== 'play' || r.players.size < 2 || now - r.lastHostMsg < CFG.hostStallMs) return;
    const old = r.hostId; let best = null; for (const q of r.players.values()) if (q.id !== old && (!best || q.joined < best.joined)) best = q;
    if (!best) return; r.hostId = best.id; r.lastHostMsg = now; unmuteHost(r); log('host stalled', r.code, old, '->', best.id);
    broadcast(r, { t: 'host', id: best.id, why: 'stalled' }, null);
  });
}, 1000));
timers.push(setInterval(() => {                                                   // temporary mutes that ran out: tell the room (the mute symbol disappears)
  const t = Date.now();
  rooms.forEach(r => r.players.forEach(p => { if (p.muteSent && !isMuted(p, t)) chatState(r, p); }));
  penalties.forEach((until, ip) => { if (until <= t) penalties.delete(ip); });
}, 2000));
for (const s of timers) s.unref();

function shutdown() { rooms.forEach(r => r.players.forEach(p => { p.conn.send({ t: 'err', code: 'shutdown', msg: 'server restarting' }); p.conn.close(1001, 'going away'); })); server.close(); setTimeout(() => process.exit(0), 500).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

if (require.main === module) {
  server.listen(CFG.port, () => console.log('Last Bell multiplayer server listening on :' + CFG.port + '  (max ' + CFG.maxPlayers + ' players per room, origins: ' + CFG.origins.join(', ') + ')'));
}
module.exports = { server, rooms, CFG, PROTO, shutdown, chatFilter };
