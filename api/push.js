const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TTL = 7200;
const GRACE = 3000;
const rid = n => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 14);

async function rx(cmds) {
  const r = await fetch(URL_ + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const d = await r.json();
  return d.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

async function load(code) {
  const [flat] = await rx([['HGETALL', 'push:' + code]]);
  const h = {};
  if (Array.isArray(flat)) { for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1]; } else Object.assign(h, flat || {});
  if (!h.meta) return null;
  const players = {}, ready = {}, counts = {};
  for (const k in h) {
    if (k.startsWith('p:')) players[k.slice(2)] = h[k];
    else if (k.startsWith('r:')) ready[k.slice(2)] = h[k];
    else if (k.startsWith('c:')) counts[k.slice(2)] = h[k];
  }
  return { meta: JSON.parse(h.meta), players, ready, counts, start: h.start ? Number(h.start) : 0 };
}

function phase(room, t) {
  if (!room.start) return 'lobby';
  const e = t - room.start;
  return e < 0 ? 'countdown' : e < room.meta.dur * 1000 + GRACE ? 'play' : 'done';
}

function view(room, pid) {
  const t = Date.now();
  const ids = Object.keys(room.players).sort((a, b) => room.players[a].localeCompare(room.players[b]));
  return {
    now: t, state: phase(room, t), start: room.start, dur: room.meta.dur,
    you: !!(pid && room.players[pid]),
    players: ids.map(id => ({ id, name: room.players[id], ready: !!room.ready[id], count: parseInt(room.counts[id] || '0') || 0 }))
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'no redis', detail: 'Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel, then redeploy' });
  try {
    const q = req.method === 'GET' ? (req.query || {}) : (req.body && typeof req.body === 'object' ? req.body : {});
    const a = req.method === 'GET' ? 'get' : q.action;
    const code = String(q.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const pid = String(q.pid || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const key = 'push:' + code;
    const bad = (s, m) => res.status(s).json({ error: m });
    const ok = () => res.status(200).json({ ok: true });

    if (a === 'create') {
      const name = cleanName(q.name);
      const dur = [30, 60, 90].includes(parseInt(q.dur)) ? parseInt(q.dur) : 60;
      if (!name) return bad(400, 'name');
      const me = rid(8);
      for (let t = 0; t < 6; t++) {
        const c = rid(5), k = 'push:' + c;
        const [made] = await rx([['HSETNX', k, 'meta', JSON.stringify({ dur })]]);
        if (made === 1) { await rx([['HSET', k, 'p:' + me, name], ['EXPIRE', k, TTL]]); return res.status(200).json({ code: c, pid: me }); }
      }
      return bad(500, 'code');
    }
    if (code.length !== 5) return bad(400, 'code');
    const room = await load(code);
    if (!room) return bad(404, 'room not found');
    const t = Date.now();
    if (a === 'get') return res.status(200).json(view(room, pid));

    if (a === 'join') {
      const name = cleanName(q.name);
      if (!name) return bad(400, 'name');
      if (room.start) return bad(409, 'game already started');
      const ids = Object.keys(room.players);
      if (ids.length >= 2) return bad(409, 'room full');
      if (ids.some(id => room.players[id].toLowerCase() === name.toLowerCase())) return bad(409, 'name taken');
      const me = rid(8);
      await rx([['HSET', key, 'p:' + me, name], ['EXPIRE', key, TTL]]);
      return res.status(200).json({ pid: me });
    }
    if (!room.players[pid]) return bad(403, 'not in room');

    if (a === 'ready') {
      if (room.start) return bad(409, 'already started');
      await rx([q.on === false ? ['HDEL', key, 'r:' + pid] : ['HSET', key, 'r:' + pid, '1']]);
      const r2 = await load(code);
      const ids = Object.keys(r2.players);
      if (ids.length === 2 && ids.every(id => r2.ready[id])) await rx([['HSETNX', key, 'start', String(Date.now() + 5000)], ['EXPIRE', key, TTL]]);
      return ok();
    }
    if (a === 'count') {
      if (!room.start) return bad(409, 'not started');
      const e = t - room.start;
      if (e < 0 || e > room.meta.dur * 1000 + GRACE) return bad(409, 'closed');
      const cap = Math.floor(e / 1000 * 1.8) + 1;
      const prev = parseInt(room.counts[pid] || '0') || 0;
      const n = Math.max(prev, Math.min(Math.max(0, parseInt(q.n) || 0), cap));
      if (n !== prev) await rx([['HSET', key, 'c:' + pid, String(n)]]);
      return res.status(200).json({ ok: true, n });
    }
    if (a === 'rematch') {
      if (phase(room, t) !== 'done') return bad(409, 'not finished');
      const del = ['start'].concat(...Object.keys(room.players).map(id => ['r:' + id, 'c:' + id]));
      await rx([['HDEL', key, ...del], ['EXPIRE', key, TTL]]);
      return ok();
    }
    return bad(400, 'action');
  } catch (e) {
    res.status(500).json({ error: 'crash', detail: String((e && e.message) || e).slice(0, 160) });
  }
};
