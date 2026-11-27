const { randomBytes } = require('crypto');
const URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TTL = 86400;
const MAX_EVENTS = 5000;
const ALLOWED_EVENTS = new Set(['join', 'roll', 'pick', 'bye', 'ping', 'full', 'lobby', 'st']);

async function redis(commands) {
  const response = await fetch(URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('redis http ' + response.status);
  const results = await response.json();
  return results.map(result => {
    if (result.error) throw new Error(result.error);
    return result.result;
  });
}

function roomCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{5}$/.test(code) ? code : '';
}

function clientId(value) {
  const id = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return /^[a-z0-9]{5,16}$/.test(id) ? id : '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL || !TOKEN) return res.status(500).json({ error: 'Room storage is not configured.' });

  try {
    const query = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {};
    const code = roomCode(query.code);
    if (!code) return res.status(400).json({ error: 'Enter a valid 5-character room code.' });

    const roomKey = 'ludo:' + code;
    const eventsKey = roomKey + ':events';
    const presenceKey = roomKey + ':presence';

    if (req.method === 'GET') {
      const bootstrap = query.bootstrap === '1';
      const cursor = Number.parseInt(query.cursor, 10);
      const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      const [host, lobby, state, hostAt, eventCount, rawEvents, active] = await redis([
        ['HGET', roomKey, 'host'],
        ['HGET', roomKey, 'lobby'],
        ['HGET', roomKey, 'state'],
        ['HGET', roomKey, 'hostAt'],
        ['LLEN', eventsKey],
        ['LRANGE', eventsKey, bootstrap ? 0 : start, bootstrap ? 0 : start + 99],
        ['ZRANGEBYSCORE', presenceKey, Date.now() - 9000, '+inf']
      ]);
      if (!host) return res.status(404).json({ error: 'Room not found. Check the code or ask the host for a new link.' });
      const hostActive = Number(hostAt) > Date.now() - 10000;
      const events = bootstrap ? [] : (Array.isArray(rawEvents) ? rawEvents : []).map((raw, index) => ({ index: start + index, message: JSON.parse(raw) }));
      return res.status(200).json({
        events,
        next: bootstrap ? Number(eventCount) || 0 : start + events.length,
        hostActive,
        active: Array.isArray(active) ? active : [],
        snapshot: { lobby: hostActive && lobby ? JSON.parse(lobby) : null, state: hostActive && state ? JSON.parse(state) : null }
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

    const action = String(query.action || '');
    const cid = clientId(query.cid);
    if (!cid) return res.status(400).json({ error: 'Invalid player session.' });

    if (action === 'create') {
      const token = randomBytes(24).toString('hex');
      const [created] = await redis([['HSETNX', roomKey, 'host', cid]]);
      if (created !== 1) return res.status(409).json({ error: 'That room code is already in use. Try again.' });
      await redis([['HSET', roomKey, 'hostAt', String(Date.now()), 'hostToken', token], ['EXPIRE', roomKey, TTL], ['EXPIRE', eventsKey, TTL], ['EXPIRE', presenceKey, TTL]]);
      return res.status(200).json({ ok: true, token });
    }

    const [host] = await redis([['HGET', roomKey, 'host']]);
    if (!host) return res.status(404).json({ error: 'Room not found. Check the code or ask the host for a new link.' });

    const [hostToken] = await redis([['HGET', roomKey, 'hostToken']]);
    if (action === 'heartbeat') {
      if (cid === host && (!hostToken || query.token !== hostToken)) return res.status(403).json({ error: 'Only the host can update the room heartbeat.' });
      const now = String(Date.now());
      const commands = [['ZADD', presenceKey, now, cid], ['EXPIRE', presenceKey, TTL], ['EXPIRE', roomKey, TTL]];
      if (cid === host) commands.unshift(['HSET', roomKey, 'hostAt', now]);
      await redis(commands);
      return res.status(200).json({ ok: true });
    }

    if (action === 'snapshot') {
      if (cid !== host || !hostToken || query.token !== hostToken) return res.status(403).json({ error: 'Only the host can update the game snapshot.' });
      const message = query.message;
      if (!message || message.k !== 'st' || !message.S) return res.status(400).json({ error: 'Invalid game snapshot.' });
      await redis([['HSET', roomKey, 'state', JSON.stringify({ ...message, c: host, hb: 1 }), 'hostAt', String(Date.now())], ['EXPIRE', roomKey, TTL]]);
      return res.status(200).json({ ok: true });
    }

    if (action !== 'send') return res.status(400).json({ error: 'Unknown room action.' });
    const message = query.message;
    if (!message || typeof message !== 'object' || !ALLOWED_EVENTS.has(message.k)) return res.status(400).json({ error: 'Invalid room message.' });
    if (JSON.stringify(message).length > 16000) return res.status(413).json({ error: 'Room message is too large.' });
    const hostMessage = ['lobby', 'st', 'full'].includes(message.k) || (message.k === 'bye' && cid === host);
    if (hostMessage && (cid !== host || !hostToken || query.token !== hostToken)) return res.status(403).json({ error: 'Only the host can send that room update.' });
    if (message.k === 'pick' && (!Number.isInteger(message.i) || message.i < 0 || message.i > 3)) return res.status(400).json({ error: 'Invalid move.' });

    const safeMessage = { ...message, c: cid };
    const rawMessage = JSON.stringify(safeMessage);
    const commands = [['LLEN', eventsKey], ['HGET', roomKey, message.k === 'lobby' ? 'lobby' : 'state']];
    const [eventCount, previous] = await redis(commands);
    const saveSnapshot = message.k === 'lobby' || message.k === 'st';
    const savedMessage = !message.hb && message.k !== 'ping';
    if (saveSnapshot && previous === rawMessage) {
      if (cid === host) await redis([['HSET', roomKey, 'hostAt', String(Date.now())], ['EXPIRE', roomKey, TTL]]);
      return res.status(200).json({ ok: true, unchanged: true });
    }

    if (savedMessage && Number(eventCount) >= MAX_EVENTS) return res.status(429).json({ error: 'This room has reached its activity limit. Start a new room.' });

    const write = [];
    if (savedMessage) write.push(['RPUSH', eventsKey, rawMessage]);
    if (saveSnapshot) write.push(['HSET', roomKey, message.k === 'lobby' ? 'lobby' : 'state', rawMessage]);
    if (cid === host) write.push(['HSET', roomKey, 'hostAt', String(Date.now())]);
    write.push(['EXPIRE', roomKey, TTL], ['EXPIRE', eventsKey, TTL]);
    await redis(write);
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Room service error.', detail: String(error && error.message || error).slice(0, 160) });
  }
};
