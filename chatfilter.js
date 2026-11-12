'use strict';
/* Last Bell - chat filter. Pure functions, no dependencies, used by server.js (and testable on its own).
 *
 * check(text, opts) -> { ok, reason, text, masked, tier, norm }
 *   ok = false:  reason 'empty' | 'contact' (link, e-mail, phone number, messenger name) | 'severe' (hate, slurs, "kill yourself" ...). The message must NOT be shown.
 *   ok = true:   `text` is the cleaned message that may be shown. masked = true when words were replaced by ***. tier = worst tier found (0 = clean, 1 mild, 2 profanity).
 * isCleanName(name) -> boolean    (word filter only, used for player names)
 *
 * What it handles: upper/lower case, umlauts and accents (ä -> a), leetspeak (sch31sse, @sch, $hit), look-alike letters (Cyrillic а/е/о ...), full-width / maths-bold letters,
 *                  stretched letters (fuuuuck), spaced out words (f u c k, f.u.c.k) and zero-width / bidi tricks. Whole words are matched, so "Marsch", "class" or "Scunthorpe" pass.
 * It is a first line of defence, not a guarantee - that is why the server adds rate limits, strikes, reports, host mute and a per-room chat mode on top (see server.js).
 *
 * Extend it without touching the code:  CHAT_EXTRA_WORDS="wort1,wort2"  (blocked, masked)   CHAT_ALLOW_WORDS="wort3"  (never blocked)
 * CrazyGames also publishes a list of words to block; add it to CHAT_EXTRA_WORDS or to the arrays below.                                                                          */

// ---------------------------------------------------------------------------------------------------- word lists (lower case, no umlauts: ä -> a, ö -> o, ü -> u, ß -> ss)
// kinds:  W = the whole word,  P = word starts with it,  R = word contains it
// tiers:  1 = mild (shown as ***),  2 = profanity (shown as ***, counts as a strike point),  3 = severe (message is dropped, 2 strike points),  4 = contact data (message is dropped)
const LISTS = [
  // ---- tier 3: hate, slurs, bullying to self-harm, sexual harassment of minors
  [3, 'W', ['kys', 'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots', 'fag', 'fags', 'retard', 'retards', 'retarded', 'kanake', 'kanaken', 'neger', 'schwuchtel', 'untermensch', 'untermenschen',
    'spast', 'spasti', 'spastis', 'mongo', 'mongos', 'pedo', 'pedos', 'pado', 'nudes', 'judensau']],
  [3, 'R', ['nigger', 'nigga', 'faggot', 'schwuchtel', 'untermensch', 'missgeburt', 'vergewaltig', 'pedophil', 'padophil', 'pedofil', 'padofil', 'kanake', 'judensau']],
  // ---- tier 2: profanity
  [2, 'W', ['ass', 'arse', 'dick', 'dicks', 'cock', 'cocks', 'cunt', 'cunts', 'twat', 'slut', 'sluts', 'whore', 'whores', 'wank', 'wanker', 'prick', 'bollocks', 'fick', 'ficken', 'ficker', 'fickt', 'gefickt',
    'fickdich', 'hure', 'huren', 'nutte', 'nutten', 'titten', 'scheisse', 'scheiss', 'kackhaufen']],
  [2, 'R', ['fuck', 'shit', 'bitch', 'bastard', 'asshole', 'arschloch', 'hurensohn', 'fotze', 'wichser', 'schlampe', 'scheiss', 'motherf', 'dickhead', 'blowjob', 'handjob', 'masturb', 'cumshot', 'ejakul']],
  [2, 'P', ['arsch', 'wichs', 'porn', 'verpiss', 'titten']],
  // ---- tier 1: mild (masked only)
  [1, 'W', ['idiot', 'idioten', 'idiotin', 'vollidiot', 'trottel', 'depp', 'deppen', 'kacke', 'kack', 'sex', 'sexy', 'penis', 'vagina', 'vagine', 'titte', 'tit', 'tits', 'boob', 'boobs', 'nazi', 'nazis', 'hitler', 'crap', 'fresse', 'orgasmus', 'orgasm']],
  // ---- tier 4: ways to leave the game with a stranger (messenger names). Links, e-mail addresses and phone numbers are found by the patterns below.
  [4, 'R', ['discord', 'snapchat', 'whatsapp', 'telegram', 'instagram', 'skype', 'tiktok']],
  [4, 'W', ['insta', 'snapname']],
];
// whole phrases, compared without spaces (so "kill  your self" and "kill-yourself" count too). Always severe.
const PHRASES = ['siegheil', 'heilhitler', 'killyourself', 'killyourselves', 'killurself', 'killyaself', 'gehsterben', 'bringdichum', 'totedich', 'ichtotedich', 'sendnudes', 'schicknudes', 'hangdichauf'];
// real words that contain a blocked root
const ALLOW_BUILTIN = ['niggardly', 'pussycat', 'assassin', 'assistant', 'assist', 'class', 'classic', 'glass', 'grass', 'pass', 'mass', 'bass', 'brass', 'assume', 'asset', 'passage', 'massage', 'cockpit', 'cocktail', 'peacock', 'hancock', 'marsch', 'scunthorpe'];

// ---------------------------------------------------------------------------------------------------- normalisation
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' };
const HOMO = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ѕ': 's', 'ј': 'j', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'ł': 'l', 'ı': 'i' };
const IGNORE = /^[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff]$/u;
const STRIP = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb]/g;   // control chars, zero-width and bidi characters
const WORDCH = /^[\p{L}\p{N}]$/u;
const squeeze3 = s => s.replace(/(.)\1{2,}/g, '$1$1');       // fuuuuck -> fuuck
const collapse1 = s => s.replace(/(.)\1+/g, '$1');            // fuuuuck -> fuck

function foldChar(ch) {
  let s = ch.toLowerCase();
  if (IGNORE.test(s)) return '';
  if (s === 'ß') return 'ss';
  if (HOMO[s]) return HOMO[s];
  s = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let o = ''; for (const c of s) o += LEET[c] || HOMO[c] || c;
  return o;
}

// ---------------------------------------------------------------------------------------------------- rules
function compile(extra, allow) {
  const rules = [];
  const add = (tier, kind, words) => { for (const w0 of words) { const w = squeeze3(String(w0).toLowerCase().trim()); if (w) rules.push({ tier, kind, w, c: collapse1(w) }); } };
  for (const [tier, kind, words] of LISTS) add(tier, kind, words);
  const ex = (extra || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  add(2, 'W', ex.filter(w => w.length < 5)); add(2, 'R', ex.filter(w => w.length >= 5));
  const al = new Set(ALLOW_BUILTIN.map(squeeze3)); for (const a of (allow || [])) { const v = squeeze3(String(a).trim().toLowerCase()); if (v) al.add(v); }
  return { rules, allow: al, phrases: PHRASES.map(squeeze3) };
}
// does this word (s2 = letters with runs squeezed to 2, c = squeezed to 1) match the rule? the collapsed form only counts for rules of 4+ letters, so "ass" never matches "as"
function hit(rule, s2, c) {
  const useC = rule.c.length >= 4;
  if (rule.kind === 'W') return s2 === rule.w || (useC && c === rule.c);
  if (rule.kind === 'P') return s2.startsWith(rule.w) || (useC && c.startsWith(rule.c));
  return s2.includes(rule.w) || (useC && c.includes(rule.c));
}

// links, e-mail addresses, @handles and phone numbers (checked on the raw text)
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]{1,}\s?(?:\.|\(dot\)|\[dot\]|\s+dot\s+)\s?(?:com|de|net|org|io|gg|tv|ly|me|co|us|eu|ru|xyz|app|info|at|ch|uk|fr|nl|pl|tk|cc|link|gl|be)\b/i;
const MAIL_RE = /[a-z0-9._%+-]+\s?(?:@|\(at\)|\[at\])\s?[a-z0-9-]+(?:\.|\s?\(dot\)\s?)[a-z]{2,}/i;
const HANDLE_RE = /(?:^|\s)@[a-z0-9_.]{3,}/i;
const PHONE_RE = /(?:\d[\s\-.()/]*){7,}/;
const hasContact = s => URL_RE.test(s) || MAIL_RE.test(s) || HANDLE_RE.test(s) || PHONE_RE.test(s);

function create(opts) {
  opts = opts || {};
  const C = compile(opts.extraWords, opts.allowWords), maxLen = opts.maxLen || 120, blockContacts = opts.blockContacts !== false;

  function tokenize(cps) {
    const toks = []; let cur = null;
    for (let i = 0; i < cps.length; i++) {
      const f = foldChar(cps[i]);
      if (f === '' && IGNORE.test(cps[i].toLowerCase())) { if (cur) cur.b = i; continue; }
      if (f && WORDCH.test(f.slice(0, 1))) { if (!cur) { cur = { s: '', a: i, b: i }; toks.push(cur); } cur.s += f.replace(/[^\p{L}\p{N}]/gu, ''); cur.b = i; } else cur = null;
    }
    for (const t of toks) { t.s2 = squeeze3(t.s); t.c = collapse1(t.s); }
    return toks.filter(t => t.s);
  }
  // best (highest tier) rule that matches a word, or null
  function best(s2, c, only) { let b = null; for (const r of C.rules) { if (only && !only(r)) continue; if ((!b || r.tier > b.tier) && hit(r, s2, c)) b = r; } return b; }

  function scan(toks, nameMode) {
    const hits = []; let tier = 0;
    const take = (a, b, t) => { hits.push({ a, b }); if (t > tier) tier = t; };
    for (const t of toks) {
      if (C.allow.has(t.s2)) continue;
      const r = best(t.s2, t.c, nameMode ? x => x.tier < 4 : null); if (r) take(t.a, t.b, r.tier);
    }
    // spaced out words: f u c k / f.u.c.k  (runs of 3+ very short words are joined)
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].s.length > 2) continue; let j = i, joined = '';
      while (j < toks.length && toks[j].s.length <= 2) { joined += toks[j].s; j++; }
      if (j - i >= 3 && joined.length >= 3) {
        const r = best(squeeze3(joined), collapse1(joined), x => x.tier < 4 && (x.kind !== 'R' || x.w.length >= 4));
        if (r) take(toks[i].a, toks[j - 1].b, r.tier);
      }
      i = j - 1;
    }
    const squashed = toks.map(t => t.s2).join('');
    if (!nameMode && C.phrases.some(p => squashed.includes(p))) tier = Math.max(tier, 3);
    return { hits, tier, squashed };
  }

  /** the message to show (or the reason why not) */
  function check(input) {
    let s = String(input == null ? '' : input).replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
    let cps = Array.from(s); if (cps.length > maxLen) { cps = cps.slice(0, maxLen); s = cps.join('').trim(); cps = Array.from(s); }
    if (!cps.length) return { ok: false, reason: 'empty', text: '', masked: false, tier: 0, norm: '' };
    if (blockContacts && hasContact(s)) return { ok: false, reason: 'contact', text: '', masked: false, tier: 4, norm: '' };
    const toks = tokenize(cps), res = scan(toks, false);
    if (blockContacts) { for (const t of toks) if (!C.allow.has(t.s2) && best(t.s2, t.c, r => r.tier === 4)) return { ok: false, reason: 'contact', text: '', masked: false, tier: 4, norm: '' }; }
    if (res.tier >= 3) return { ok: false, reason: 'severe', text: '', masked: false, tier: 3, norm: '' };
    const mask = new Uint8Array(cps.length);
    for (const h of res.hits) for (let k = h.a; k <= h.b; k++) { const f = foldChar(cps[k]); if (f && WORDCH.test(f.slice(0, 1))) mask[k] = 1; }   // also @ and $ (leetspeak letters)
    let out = cps.map((c, k) => (mask[k] ? '*' : c)).join('');
    out = out.replace(/(.)\1{3,}/gu, '$1$1$1');                                           // aaaaaaa -> aaa, !!!!!!! -> !!!
    const letters = out.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 8 && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.7) { out = out.toLowerCase(); out = out.charAt(0).toUpperCase() + out.slice(1); }   // SHOUTING -> Shouting
    return { ok: true, reason: '', text: out.trim(), masked: res.hits.length > 0, tier: res.tier, norm: res.squashed.slice(0, 100) };
  }
  /** names: only the word filter (a CrazyGames user name such as "xX_Pro_1234567" must not be mistaken for a phone number) */
  function isCleanName(name) { const toks = tokenize(Array.from(String(name == null ? '' : name).replace(STRIP, ''))); return scan(toks, true).tier === 0; }
  return { check, isCleanName, rules: C.rules.length };
}

const parseList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
module.exports = { create, fromEnv: env => create({ extraWords: parseList((env || process.env).CHAT_EXTRA_WORDS), allowWords: parseList((env || process.env).CHAT_ALLOW_WORDS), blockContacts: (env || process.env).CHAT_BLOCK_CONTACTS !== '0', maxLen: +(env || process.env).CHAT_MAX_LEN > 0 ? +(env || process.env).CHAT_MAX_LEN : 120 }) };
