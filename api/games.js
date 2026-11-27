const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const { del } = require('@vercel/blob');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ROOM_TTL = 6 * 60 * 60;
const MAX_PLAYERS = 8;
const MAX_EVENT_BYTES = 5000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BUILT_IN_GAME_IDS = new Set(['03ecc1e7-a5a4-4a89-be17-b204f6d0eb15']);

async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Game room storage is not configured.');
  const response = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('Room storage returned HTTP ' + response.status);
  const results = await response.json();
  return results.map(result => { if (result.error) throw new Error(result.error); return result.result; });
}

function code(value) { const result = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z0-9]{5}$/.test(result) ? result : ''; }
function safeId(value) { const result = String(value || '').toLowerCase(); return /^[a-f0-9-]{36}$/.test(result) ? result : ''; }
function safeName(value) { return String(value || '').replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 18); }
function parseObject(value) { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch (_) { return {}; } }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function playerId() { return randomBytes(16).toString('hex'); }
function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function capabilityToken(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization || ''));
  return match ? match[1] : '';
}
function validAdmin(req) {
  const expected = Buffer.from(process.env.GAME_MODERATION_SECRET || '');
  const supplied = Buffer.from(String(req.headers['x-game-moderation-secret'] || ''));
  if (!expected.length || supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}
function tokenMatches(raw, saved) {
  if (!raw || !saved) return false;
  const a = Buffer.from(hash(raw)); const b = Buffer.from(saved);
  return a.length === b.length && timingSafeEqual(a, b);
}
function makeCode() { return Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }

async function rateLimit(req, action, limit, seconds) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80);
  const key = `game-rate:${action}:${ip}`;
  const [count] = await redis([['INCR', key], ['EXPIRE', key, seconds]]);
  return Number(count) <= limit;
}

async function loadRoom(roomCode) {
  const key = 'groom:' + roomCode;
  const [meta, state, rawPlayers, eventsLength] = await redis([
    ['HGET', key, 'meta'], ['HGET', key, 'state'], ['HGETALL', key + ':players'], ['LLEN', key + ':events']
  ]);
  if (!meta) return null;
  const players = {};
  if (Array.isArray(rawPlayers)) for (let index = 0; index < rawPlayers.length; index += 2) players[rawPlayers[index]] = rawPlayers[index + 1];
  else Object.assign(players, rawPlayers || {});
  return { key, meta: parseObject(meta), state: parseObject(state), players, eventsLength: Number(eventsLength) || 0 };
}

function authorizedPlayer(room, pid) { return !!pid && Object.prototype.hasOwnProperty.call(room.players, pid); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: 'Game room storage is not configured.' });
  const query = req.method === 'GET' ? req.query || {} : req.body && typeof req.body === 'object' ? req.body : {};
  const action = req.method === 'GET' ? String(query.action || 'list') : String(query.action || '');
  const bad = (status, message) => res.status(status).json({ error: message });

  try {
    if (action === 'list' && req.method === 'GET') {
      const [ids] = await redis([['SMEMBERS', 'games:approved']]);
      if (!Array.isArray(ids) || !ids.length) return res.status(200).json({ games: [] });
      const rows = await redis(ids.map(id => ['HGETALL', 'game:' + id]));
      const games = rows.map((row, index) => {
        const item = {};
        if (Array.isArray(row)) for (let i = 0; i < row.length; i += 2) item[row[i]] = row[i + 1];
        else Object.assign(item, row || {});
        return { id: ids[index], title: item.title, description: item.description, indexUrl: item.indexUrl, createdAt: item.createdAt };
      }).filter(item => item.title && item.indexUrl && !BUILT_IN_GAME_IDS.has(item.id));
      return res.status(200).json({ games });
    }

    if (action === 'admin-list' && req.method === 'GET') {
      if (!validAdmin(req)) return bad(401, 'Moderation access denied.');
      const [rawIds, rawReportIds] = await redis([['SMEMBERS', 'games:all'], ['SMEMBERS', 'game-reports']]);
      const ids = Array.isArray(rawIds) ? rawIds : [];
      const reportIds = Array.isArray(rawReportIds) ? rawReportIds : [];
      const rows = ids.length ? await redis(ids.map(id => ['HGETALL', 'game:' + id])) : [];
      const gameNames = new Map();
      const games = rows.map((row, index) => {
        const item = {};
        if (Array.isArray(row)) for (let i = 0; i < row.length; i += 2) item[row[i]] = row[i + 1];
        else Object.assign(item, row || {});
        gameNames.set(ids[index], item.title || 'Untitled game');
        return { id: ids[index], title: item.title, description: item.description, status: item.status, indexUrl: item.indexUrl, createdAt: item.createdAt };
      });
      const reportRows = reportIds.length ? await redis(reportIds.map(id => ['HGETALL', 'game-report:' + id])) : [];
      const reports = reportRows.map((row, index) => {
        const item = {};
        if (Array.isArray(row)) for (let i = 0; i < row.length; i += 2) item[row[i]] = row[i + 1];
        else Object.assign(item, row || {});
        return { id: reportIds[index], gameId: item.gameId, gameTitle: gameNames.get(item.gameId) || 'Removed game', reason: item.reason, createdAt: item.createdAt };
      });
      return res.status(200).json({ games, reports });
    }

    if (req.method !== 'POST' && !(req.method === 'GET' && ['room', 'agent-state'].includes(action))) return bad(405, 'Method not allowed.');
    if (req.method === 'POST' && Buffer.byteLength(JSON.stringify(query)) > MAX_EVENT_BYTES + 2000) return bad(413, 'Request is too large.');

    if (action === 'moderate') {
      if (!validAdmin(req)) return bad(401, 'Moderation access denied.');
      const id = safeId(query.id);
      const status = ['approved', 'rejected', 'hidden'].includes(query.status) ? query.status : '';
      if (!id || !status) return bad(400, 'Invalid moderation request.');
      const [exists] = await redis([['EXISTS', 'game:' + id]]);
      if (!exists) return bad(404, 'Game not found.');
      const commands = [['HSET', 'game:' + id, 'status', status, 'reviewedAt', String(Date.now())]];
      if (status === 'approved') commands.push(['SADD', 'games:approved', id]);
      else commands.push(['SREM', 'games:approved', id]);
      await redis(commands);
      if (status !== 'approved') {
        const [rawFiles] = await redis([['HGET', 'game:' + id, 'files']]);
        let urls = [];
        try { urls = JSON.parse(rawFiles || '[]').map(file => new URL(file.url)).filter(url => url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com') && url.pathname.includes('/games/' + id + '/')).map(url => url.href); } catch (_) {}
        if (urls.length) await del(urls);
      }
      return res.status(200).json({ ok: true, status });
    }

    if (action === 'report') {
      if (!await rateLimit(req, 'report', 10, 3600)) return bad(429, 'Too many reports. Try again later.');
      const id = safeId(query.id);
      const reason = String(query.reason || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 240);
      if (!id || reason.length < 6) return bad(400, 'Choose a game and provide a short report.');
      const [exists] = await redis([['SISMEMBER', 'games:approved', id]]);
      if (!exists) return bad(404, 'Game not found.');
      const reportId = randomBytes(8).toString('hex');
      await redis([['HSET', 'game-report:' + reportId, 'gameId', id, 'reason', reason, 'createdAt', String(Date.now())], ['SADD', 'game-reports', reportId], ['EXPIRE', 'game-report:' + reportId, 2592000], ['EXPIRE', 'game-reports', 2592000]]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'create-room') {
      if (!await rateLimit(req, 'create-room', 20, 3600)) return bad(429, 'Room creation limit reached. Try again later.');
      const gameId = safeId(query.gameId);
      const name = safeName(query.name);
      if (!gameId || !name) return bad(400, 'Game and player name are required.');
      const [approved] = await redis([['SISMEMBER', 'games:approved', gameId]]);
      if (!approved) return bad(404, 'That game is not available.');
      for (let attempt = 0; attempt < 8; attempt++) {
        const roomCode = makeCode();
        const key = 'groom:' + roomCode;
        const pid = playerId();
        const agentToken = randomBytes(32).toString('base64url');
        const friendToken = randomBytes(24).toString('base64url');
        const meta = { gameId, createdAt: Date.now(), host: pid, friendTokenHash: hash(friendToken), aiTokenHash: hash(agentToken), aiJoined: false, eventCount: 0 };
        const [created] = await redis([['HSETNX', key, 'meta', JSON.stringify(meta)]]);
        if (Number(created) !== 1) continue;
        await redis([['HSET', key + ':players', pid, name], ['EXPIRE', key, ROOM_TTL], ['EXPIRE', key + ':players', ROOM_TTL], ['EXPIRE', key + ':events', ROOM_TTL]]);
        return res.status(200).json({ code: roomCode, pid, agentToken, friendToken, gameId, players: [{ id: pid, name }], expiresIn: ROOM_TTL });
      }
      return bad(503, 'Could not create a room. Try again.');
    }

    if (action === 'join-room') {
      if (!await rateLimit(req, 'join-room', 40, 3600)) return bad(429, 'Join limit reached. Try again later.');
      const roomCode = code(query.code);
      const name = safeName(query.name);
      if (!roomCode || !name) return bad(400, 'Room code and player name are required.');
      const room = await loadRoom(roomCode);
      if (!room || !tokenMatches(capabilityToken(req), room.meta.friendTokenHash)) return bad(404, 'Room invite is invalid or expired.');
      const pid = playerId();
      const script = "if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end; local names=redis.call('HVALS',KEYS[2]); if #names >= tonumber(ARGV[2]) then return 'full' end; for _,n in ipairs(names) do if string.lower(n)==string.lower(ARGV[3]) then return 'taken' end end; redis.call('HSET',KEYS[2],ARGV[1],ARGV[3]); redis.call('EXPIRE',KEYS[2],ARGV[4]); return 'ok'";
      const [joined] = await redis([['EVAL', script, 2, room.key, room.key + ':players', pid, MAX_PLAYERS, name, ROOM_TTL]]);
      if (joined !== 'ok') return bad(409, joined === 'full' ? 'This game is full.' : joined === 'taken' ? 'That player name is already in use.' : 'Room not found or expired.');
      const fresh = await loadRoom(roomCode);
      return res.status(200).json({ code: roomCode, pid, gameId: room.meta.gameId, players: Object.entries(fresh.players).map(([id, playerName]) => ({ id, name: playerName })) });
    }

    if (action === 'room' && req.method === 'GET') {
      const roomCode = code(query.code);
      const pid = String(query.pid || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
      const cursor = Math.max(0, Math.min(1000000, Number.parseInt(query.cursor, 10) || 0));
      const room = roomCode && await loadRoom(roomCode);
      if (!room || !authorizedPlayer(room, pid)) return bad(404, 'Room not found or player session expired.');
      if (!await rateLimit(req, 'poll:' + roomCode, 180, 60)) return bad(429, 'Room polling limit reached. Slow down and try again.');
      const [rawEvents, activeAgent] = await redis([
        ['LRANGE', room.key + ':events', cursor, cursor + 49],
        ['HGET', room.key, 'agentPid']
      ]);
      const events = Array.isArray(rawEvents) ? rawEvents.map((raw, index) => ({ index: cursor + index, ...parseObject(raw) })) : [];
      return res.status(200).json({ gameId: room.meta.gameId, players: Object.entries(room.players).map(([id, name]) => ({ id, name })), events, next: cursor + events.length, total: room.meta.eventCount || room.eventsLength, agentJoined: !!activeAgent, agentState: room.state.agentState || null });
    }

    if (action === 'event') {
      const roomCode = code(query.code);
      const pid = String(query.pid || '').replace(/[^a-f0-9]/g, '').slice(0, 32);
      const type = String(query.type || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
      const room = roomCode && await loadRoom(roomCode);
      if (!room || !authorizedPlayer(room, pid)) return bad(404, 'Room not found or player session expired.');
      if (!type) return bad(400, 'Event type is required.');
      const data = query.data === undefined ? null : query.data;
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_BYTES) return bad(413, 'Game event is too large.');
      if (!await rateLimit(req, 'event:' + roomCode, 240, 60)) return bad(429, 'Game event limit reached.');
      const event = { type, data, from: pid, at: Date.now() };
      const commands = [['RPUSH', room.key + ':events', JSON.stringify(event)], ['HINCRBY', room.key, 'eventCount', 1], ['EXPIRE', room.key, ROOM_TTL], ['EXPIRE', room.key + ':events', ROOM_TTL]];
      const [eventCount] = await redis([['LLEN', room.key + ':events']]);
      if (Number(eventCount) >= 3000) return bad(429, 'This room has reached its activity limit. Start a new room.');
      if (type === 'agent-state') {
        if (pid !== room.meta.host) return bad(403, 'Only the room host can publish AI state and legal actions.');
        const agentState = query.data && typeof query.data === 'object' ? query.data : {};
        if (JSON.stringify(agentState).length > MAX_EVENT_BYTES) return bad(413, 'AI game state is too large.');
        commands.unshift(['HSET', room.key, 'state', JSON.stringify({ ...room.state, agentState })]);
      }
      await redis(commands);
      return res.status(200).json({ ok: true });
    }

    if (action === 'agent-state' && req.method === 'GET') {
      const roomCode = code(query.code);
      const room = roomCode && await loadRoom(roomCode);
      const savedToken = room && room.meta.aiTokenHash;
      if (!room || !tokenMatches(capabilityToken(req), savedToken)) return bad(404, 'Agent invite is invalid or expired.');
      if (!await rateLimit(req, 'agent-poll:' + roomCode, 120, 60)) return bad(429, 'Agent polling limit reached. Slow down and try again.');
      const reserveAgent = "if redis.call('EXISTS',KEYS[1])==0 then return 'missing' end; if redis.call('HEXISTS',KEYS[1],'agentPid')==1 then return 'ok' end; local names=redis.call('HVALS',KEYS[2]); if #names>=tonumber(ARGV[1]) then return 'full' end; redis.call('HSET',KEYS[2],'agent','Whosaid AI'); redis.call('HSET',KEYS[1],'agentPid','agent'); redis.call('EXPIRE',KEYS[2],ARGV[2]); return 'ok'";
      const [joined] = await redis([['EVAL', reserveAgent, 2, room.key, room.key + ':players', MAX_PLAYERS, ROOM_TTL]]);
      if (joined !== 'ok') return bad(409, joined === 'full' ? 'This room is full.' : 'Room not found or expired.');
      const fresh = await loadRoom(roomCode);
      const gameRows = await redis([['HGET', 'game:' + room.meta.gameId, 'title'], ['HGET', 'game:' + room.meta.gameId, 'indexUrl']]);
      return res.status(200).json({ game: { id: room.meta.gameId, title: gameRows[0], url: gameRows[1] }, room: roomCode, players: Object.entries(fresh.players).map(([id, name]) => ({ id, name })), agentState: room.state.agentState || null, instructions: 'Choose one action from legalActions in agentState and POST it to /api/games with action=agent-move, code, and move. Poll this endpoint for updates. Do not invent actions outside legalActions.' });
    }

    if (action === 'agent-move') {
      const roomCode = code(query.code);
      const room = roomCode && await loadRoom(roomCode);
      const savedToken = room && room.meta.aiTokenHash;
      if (!room || !tokenMatches(capabilityToken(req), savedToken)) return bad(404, 'Agent invite is invalid or expired.');
      const move = query.move;
      if (!move || typeof move !== 'object' || Array.isArray(move) || Buffer.byteLength(JSON.stringify(move)) > 1000) return bad(400, 'Provide a valid game action.');
      const legalActions = room.state.agentState && room.state.agentState.legalActions;
      if (!Array.isArray(legalActions) || !legalActions.some(action => canonical(action) === canonical(move))) return bad(400, 'That action is not in the game’s current legal action list.');
      if (!await rateLimit(req, 'agent-move:' + roomCode, 30, 60)) return bad(429, 'Agent move limit reached.');
      const [count] = await redis([['LLEN', room.key + ':events']]);
      if (Number(count) >= 3000) return bad(429, 'This room has reached its activity limit.');
      const event = { type: 'agent-action', data: move, from: 'agent', at: Date.now() };
      await redis([['RPUSH', room.key + ':events', JSON.stringify(event)], ['HINCRBY', room.key, 'eventCount', 1], ['HSET', room.key, 'agentPid', 'agent'], ['EXPIRE', room.key, ROOM_TTL], ['EXPIRE', room.key + ':events', ROOM_TTL]]);
      return res.status(200).json({ ok: true });
    }

    return bad(400, 'Unknown game action.');
  } catch (error) {
    return res.status(500).json({ error: 'Game service error.', detail: String(error && error.message || error).slice(0, 160) });
  }
};
