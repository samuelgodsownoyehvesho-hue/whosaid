const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TTL = 86400;
const rid = n => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 14);
const cleanQs = a => (Array.isArray(a) ? a : []).filter(s => typeof s === 'string').map(s => s.replace(/\s+/g, ' ').trim().slice(0, 120)).filter(s => s.length >= 10).slice(0, 6);
const closed = (m, p, v) => m.forced === m.i || Object.keys(v[m.i] || {}).length >= Object.keys(p).length;

async function rx(cmds) {
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const d = await r.json();
  return d.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

async function load(code) {
  const [flat] = await rx([['HGETALL', 'room:' + code]]);
  const h = {};
  if (Array.isArray(flat)) { for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1]; } else Object.assign(h, flat || {});
  if (!h.meta) return null;
  const players = {}, votes = {};
  for (const k in h) {
    if (k.startsWith('p:')) players[k.slice(2)] = h[k];
    else if (k.startsWith('v:')) { const [, r, id] = k.split(':'); (votes[r] = votes[r] || {})[id] = h[k]; }
  }
  return { meta: JSON.parse(h.meta), players, votes };
}

function view(room, pid) {
  const { meta, players, votes } = room;
  const ids = Object.keys(players).sort((a, b) => players[a].localeCompare(players[b]));
  const i = meta.i, cur = votes[i] || {};
  const revealed = meta.phase === 'play' && closed(meta, players, votes);
  const state = meta.phase === 'lobby' ? 'lobby' : meta.phase === 'done' ? 'done' : revealed ? 'reveal' : 'voting';
  const tally = r => { const t = {}; Object.values(votes[r] || {}).forEach(x => { t[x] = (t[x] || 0) + 1; }); return t; };
  const out = {
    state, i, total: meta.qs.length, host: meta.host, you: !!(pid && players[pid]), mine: (pid && cur[pid]) || null,
    players: ids.map(id => ({ id, name: players[id], voted: !!cur[id] })),
    question: state === 'lobby' ? null : meta.qs[Math.min(i, meta.qs.length - 1)]
  };
  if (state === 'reveal') out.tally = tally(i);
  if (state === 'done') out.rounds = meta.qs.map((q, r) => ({ q, tally: tally(r) }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'no redis', detail: 'Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel, then redeploy' });
  try {
    const q = req.method === 'GET' ? (req.query || {}) : (req.body && typeof req.body === 'object' ? req.body : {});
    const a = req.method === 'GET' ? 'get' : q.action;
    const code = String(q.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const pid = String(q.pid || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const key = 'room:' + code;
    const bad = (s, m) => res.status(s).json({ error: m });
    const ok = () => res.status(200).json({ ok: true });

    if (a === 'create') {
      const name = cleanName(q.name), qs = cleanQs(q.qs);
      if (!name) return bad(400, 'name');
      if (qs.length < 6) return bad(400, 'questions');
      const me = rid(8);
      for (let t = 0; t < 6; t++) {
        const c = rid(5), k = 'room:' + c;
        const [made] = await rx([['HSETNX', k, 'meta', JSON.stringify({ host: me, qs, i: 0, phase: 'lobby', forced: -1 })]]);
        if (made === 1) { await rx([['HSET', k, 'p:' + me, name], ['EXPIRE', k, TTL]]); return res.status(200).json({ code: c, pid: me }); }
      }
      return bad(500, 'code');
    }
    if (code.length !== 5) return bad(400, 'code');
    const room = await load(code);
    if (!room) return bad(404, 'room not found');
    const { meta, players, votes } = room;
    if (a === 'get') return res.status(200).json(view(room, pid));

    if (a === 'join') {
      const name = cleanName(q.name);
      if (!name) return bad(400, 'name');
      if (meta.phase !== 'lobby') return bad(409, 'game already started');
      const ids = Object.keys(players);
      if (ids.length >= 12) return bad(409, 'room full');
      if (ids.some(id => players[id].toLowerCase() === name.toLowerCase())) return bad(409, 'name taken');
      const me = rid(8);
      await rx([['HSET', key, 'p:' + me, name], ['EXPIRE', key, TTL]]);
      return res.status(200).json({ pid: me });
    }
    if (!players[pid]) return bad(403, 'not in room');

    if (a === 'vote') {
      const r = parseInt(q.r), target = String(q.target || '').toUpperCase();
      if (meta.phase !== 'play' || r !== meta.i || closed(meta, players, votes)) return bad(409, 'round closed');
      if (!players[target] || target === pid) return bad(400, 'target');
      await rx([['HSET', key, 'v:' + r + ':' + pid, target]]);
      return ok();
    }

    if (meta.host !== pid) return bad(403, 'host only');
    const save = m => rx([['HSET', key, 'meta', JSON.stringify(m)], ['EXPIRE', key, TTL]]);
    if (a === 'start') {
      if (meta.phase !== 'lobby' || Object.keys(players).length < 2) return bad(409, 'need 2 players');
      await save({ ...meta, phase: 'play', i: 0, forced: -1 });
      return ok();
    }
    if (a === 'reveal') { if (meta.phase === 'play') await save({ ...meta, forced: meta.i }); return ok(); }
    if (a === 'next') {
      if (meta.phase !== 'play' || !closed(meta, players, votes)) return bad(409, 'not revealed');
      await save(meta.i >= meta.qs.length - 1 ? { ...meta, phase: 'done' } : { ...meta, i: meta.i + 1, forced: -1 });
      return ok();
    }
    if (a === 'again') {
      const qs = cleanQs(q.qs);
      if (qs.length < 6) return bad(400, 'questions');
      const del = [];
      Object.keys(votes).forEach(r => Object.keys(votes[r]).forEach(id => del.push('v:' + r + ':' + id)));
      const cmds = [];
      if (del.length) cmds.push(['HDEL', key, ...del]);
      cmds.push(['HSET', key, 'meta', JSON.stringify({ host: meta.host, qs, i: 0, phase: 'lobby', forced: -1 })], ['EXPIRE', key, TTL]);
      await rx(cmds);
      return ok();
    }
    return bad(400, 'action');
  } catch (e) {
    res.status(500).json({ error: 'crash', detail: String((e && e.message) || e).slice(0, 160) });
  }
};
