'use strict';
/* friends.js - friend IDs, presence, friend requests and invitations for the Last Bell relay server (loaded by server.js).
 *
 * No accounts, no database. A player's friend ID is the hash of a public key that HIS BROWSER generated (ECDSA P-256). To log in, the browser signs a random challenge
 * with the private key (which never leaves the browser), so nobody can pretend to be somebody else's ID. A friendship lives only in the two browsers: A and B are friends
 * when each of them has the other one's ID in his own list ("mutual"). The server never lets a player find out about someone who has not added him:
 *   - presence (online / in a lobby / playing, name, room code) goes only to MUTUAL friends,
 *   - a friend request is only a message "X added you" to someone who is online right now (or later, when he comes online while X is online),
 *   - IDs cannot be searched or listed.
 * In memory only: who is online, the ID list he sent, his name. Nothing is written to disk and nothing is logged.
 *
 * Messages  client -> server:  fauth {pub} | fproof {sig} | flist {ids, name, tt} | finfo {name, tt} | fblock {id, on} | finv {to} | fbye
 *           server -> client:  fchal {n} | fok {pid} | fall {list} | fpres {pid, st, name, room, tt} | freq {from, name} | finv {from, name, room} | fack {what, to} | ferr {code} | fdup
 * st = 'on' (online, no room) | 'lobby' | 'play' | 'off'.   room = code, only when the room is open and not full (so a friend can join).                                       */
const crypto = require('crypto');

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';                                // Crockford base32 (no I L O U)
const PID_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const TYPES = new Set(['fauth', 'fproof', 'flist', 'finfo', 'fblock', 'finv', 'fbye']);
const TITLE_COUNT = 8;                                                         // equipped shop title: index 0..7, the client has the texts (see shop.js TITLES). -1 = none

function b32(buf, len) {
  let out = '', acc = 0, bits = 0;
  for (const byte of buf) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHA[(acc >> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1; if (out.length >= len) return out; } }
  return out;
}
/** friend ID = first 10 characters (50 bits) of base32(SHA-256(raw public key: 04 | x | y)) */
const pidOf = raw => b32(crypto.createHash('sha256').update(raw).digest(), 10);
const tt = v => (Number.isInteger(v) && v >= 0 && v < TITLE_COUNT ? v : -1);

function create(deps) {
  const CFG = deps.CFG, safeName = deps.safeName, ids = new Map();               // pid -> conn (authenticated, online)
  const enabled = () => CFG.friendsEnabled;
  const ferr = (c, code) => c.send({ t: 'ferr', code });

  function bucket(c) {                                                           // flood limit for all friend messages of one connection
    const t = Date.now(); c.ftok = Math.min(CFG.friendsBurst, (c.ftok === undefined ? CFG.friendsBurst : c.ftok) + (t - (c.ftAt || t)) / 1000 * CFG.friendsRate); c.ftAt = t;
    if (c.ftok < 1) return false; c.ftok -= 1; return true;
  }
  function presence(c) {
    const r = c.room;
    return { pid: c.pid, st: r ? (r.cfg.state === 'play' ? 'play' : 'lobby') : 'on', name: c.fname || 'Spieler', room: r && r.open && r.players.size < r.max ? r.code : undefined, tt: c.ftt };
  }
  const mutual = (a, b) => !!(a.fr && b.fr && a.pid && b.pid && a.fr.has(b.pid) && b.fr.has(a.pid));
  function mutualOnline(c) { const list = []; for (const pid of c.fr) { const o = ids.get(pid); if (o && o !== c && o.fr.has(c.pid)) list.push(presence(o)); } return list; }
  /** tell every online mutual friend how c looks now */
  function push(c) { if (!c.pid) return; const p = Object.assign({ t: 'fpres' }, presence(c)); for (const pid of c.fr) { const o = ids.get(pid); if (o && o !== c && o.fr.has(c.pid)) o.send(p); } }
  function pushOff(c) { if (!c.pid) return; for (const pid of c.fr) { const o = ids.get(pid); if (o && o !== c && o.fr.has(c.pid)) o.send({ t: 'fpres', pid: c.pid, st: 'off' }); } }
  function detach(c) { if (!c.pid) return; pushOff(c); if (ids.get(c.pid) === c) ids.delete(c.pid); c.pid = null; c.fr = null; c.fblock = null; c.fsynced = false; }

  /** requests: (1) those c just caused by adding somebody who is online, (2) those that wait for c (somebody online added him earlier). At most one per sender and receiver per CFG.friendReqGapMs. */
  function requests(c, before) {
    const t = Date.now(), gap = CFG.friendReqGapMs, allowed = (to, from) => { to.freqIn = to.freqIn || new Map(); if (t - (to.freqIn.get(from) || 0) < gap) return false; to.freqIn.set(from, t); return true; };
    for (const pid of c.fr) {
      if (before.has(pid)) continue; const o = ids.get(pid);
      if (!o || o.fr.has(c.pid) || o.fblock.has(c.pid) || !allowed(o, c.pid)) continue;
      o.send({ t: 'freq', from: c.pid, name: c.fname || 'Spieler' });
    }
    if (c.fsynced) return; c.fsynced = true;
    for (const o of ids.values()) {
      if (o === c || !o.fr.has(c.pid) || c.fr.has(o.pid) || c.fblock.has(o.pid) || !allowed(c, o.pid)) continue;
      c.send({ t: 'freq', from: o.pid, name: o.fname || 'Spieler' });
    }
  }

  function handle(c, m) {
    if (!enabled()) return ferr(c, 'off');
    if (m.t === 'fauth') {
      if (c.pid) return; if ((c.fauthN = (c.fauthN || 0) + 1) > 8) return ferr(c, 'rate');
      if (ids.size >= CFG.friendsMaxOnline) return ferr(c, 'full');
      if (typeof m.pub !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(m.pub)) return ferr(c, 'key');
      const raw = Buffer.from(m.pub, 'base64url'); if (raw.length !== 65 || raw[0] !== 4) return ferr(c, 'key');
      let key; try { key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' }); } catch (e) { return ferr(c, 'key'); }
      const nonce = crypto.randomBytes(16).toString('hex'); c.fch = { key, pid: pidOf(raw), nonce }; return c.send({ t: 'fchal', n: nonce });
    }
    if (m.t === 'fproof') {
      const ch = c.fch; c.fch = null; if (!ch || c.pid || typeof m.sig !== 'string' || m.sig.length > 200) return ferr(c, 'auth');
      let ok = false; try { ok = crypto.verify('sha256', Buffer.from('LB1:' + ch.nonce), { key: ch.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m.sig, 'base64url')); } catch (e) { ok = false; }
      if (!ok) return ferr(c, 'auth');
      const old = ids.get(ch.pid); if (old && old !== c) { old.send({ t: 'fdup' }); detach(old); }        // the same browser opened a second tab: the newest connection wins
      c.pid = ch.pid; c.fr = new Set(); c.fblock = new Set(); c.fsynced = false; c.ftt = -1; c.fname = c.player ? c.player.name : 'Spieler'; ids.set(c.pid, c);
      return c.send({ t: 'fok', pid: c.pid });
    }
    if (m.t === 'fbye') return detach(c);
    if (!c.pid) return ferr(c, 'auth');
    if (!bucket(c)) return;
    switch (m.t) {
      case 'flist': {
        const set = new Set(); for (const x of Array.isArray(m.ids) ? m.ids : []) { if (typeof x === 'string' && PID_RE.test(x) && x !== c.pid) set.add(x); if (set.size >= CFG.friendsMax) break; }
        const before = c.fr; c.fr = set;
        if ('name' in m) c.fname = safeName(m.name, c.fname || 'Spieler'); if ('tt' in m) c.ftt = tt(m.tt);
        c.send({ t: 'fall', list: mutualOnline(c) }); push(c); requests(c, before); return;
      }
      case 'finfo': { if ('name' in m) c.fname = safeName(m.name, c.fname || 'Spieler'); if ('tt' in m) c.ftt = tt(m.tt); return push(c); }
      case 'fblock': {
        if (typeof m.id !== 'string' || !PID_RE.test(m.id) || m.id === c.pid) return;
        if (m.on) { if (c.fblock.size < CFG.friendsMax * 4) c.fblock.add(m.id); } else c.fblock.delete(m.id); return;
      }
      case 'finv': {
        const o = typeof m.to === 'string' ? ids.get(m.to) : null, r = c.room;
        if (!o || o === c || !mutual(c, o) || !r || !r.open || r.players.size >= r.max || o.room === r) return;       // silent: nobody learns anything from an invitation that is not allowed
        const t = Date.now(); c.finvSent = c.finvSent || new Map(); if (t - (c.finvSent.get(o.pid) || 0) < CFG.friendInviteGapMs) return ferr(c, 'rate');
        c.finvSent.set(o.pid, t); o.send({ t: 'finv', from: c.pid, name: c.fname || 'Spieler', room: r.code }); return c.send({ t: 'fack', what: 'inv', to: o.pid });
      }
      default: return;
    }
  }
  return {
    is: t => TYPES.has(t), handle, touch: c => push(c), touchRoom: room => { for (const p of room.players.values()) push(p.conn); },
    onClose: c => { c.fch = null; detach(c); }, online: () => ids.size, pidOf,
  };
}
module.exports = { create, pidOf, b32, PID_RE, TITLE_COUNT };
