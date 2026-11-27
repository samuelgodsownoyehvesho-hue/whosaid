const { handleUpload } = require('@vercel/blob/client');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const COVER_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const MAX_COVER_BYTES = 2 * 1024 * 1024;

async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Game catalog storage is not configured.');
  const response = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!response.ok) throw new Error('Catalog storage returned HTTP ' + response.status);
  const results = await response.json();
  return results.map(result => { if (result.error) throw new Error(result.error); return result.result; });
}

function cleanPayload(payload) {
  let value = {};
  try { value = typeof payload === 'string' ? JSON.parse(payload) : payload || {}; } catch (_) {}
  const id = String(value.id || '').toLowerCase();
  const extension = String(value.extension || '').toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(id) || !Object.hasOwn(COVER_TYPES, extension)) throw new Error('Invalid cover upload.');
  return { id, extension };
}

async function readRaw(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('Upload request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'Game uploads are not configured yet.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  try {
    const raw = await readRaw(req, 1024 * 1024);
    const body = JSON.parse(raw);
    const host = req.headers.host || 'whosaid.vercel.app';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(', '));
    }
    const request = new Request(`https://${host}${req.url || '/api/games/cover-upload'}`, { method: 'POST', headers, body: raw });
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const metadata = cleanPayload(clientPayload);
        if (pathname !== `incoming-covers/${metadata.id}.${metadata.extension}`) throw new Error('Invalid cover upload path.');
        const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80);
        const [count] = await redis([['INCR', 'game-cover-rate:' + ip], ['EXPIRE', 'game-cover-rate:' + ip, 3600]]);
        if (Number(count) > 5) throw new Error('Cover upload limit reached. Try again in an hour.');
        return {
          allowedContentTypes: [COVER_TYPES[metadata.extension]],
          maximumSizeInBytes: MAX_COVER_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify(metadata),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = cleanPayload(tokenPayload);
        const url = new URL(blob.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.public.blob.vercel-storage.com')) throw new Error('Cover storage returned an invalid URL.');
        await redis([['HSET', 'game:' + metadata.id, 'coverUrl', url.href, 'coverType', COVER_TYPES[metadata.extension]]]);
      },
    });
    return res.status(200).json(response);
  } catch (error) {
    const message = String(error && error.message || 'Cover upload could not be processed.').slice(0, 180);
    return res.status(400).json({ error: message });
  }
};

module.exports.config = { api: { bodyParser: false } };
