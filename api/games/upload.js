const { handleUpload } = require('@vercel/blob/client');
const { del, put } = require('@vercel/blob');
const { unzipSync } = require('fflate');
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 60;
const MIME_TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  ico: 'image/x-icon', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm', xml: 'application/xml',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

async function redis(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error('Game catalog storage is not configured.');
  const response = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error('Catalog storage returned HTTP ' + response.status);
  const results = await response.json();
  return results.map(result => { if (result.error) throw new Error(result.error); return result.result; });
}

function cleanMetadata(payload) {
  let value = {};
  try { value = typeof payload === 'string' ? JSON.parse(payload) : payload || {}; } catch (_) {}
  const id = String(value.id || '').toLowerCase();
  const title = String(value.title || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 48);
  const description = String(value.description || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 240);
  if (!/^[a-f0-9-]{36}$/.test(id) || !title || !description) throw new Error('Please provide a valid game title and description.');
  return { id, title, description };
}

function readDirectory(bytes) {
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The upload is not a supported ZIP archive.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (!count || count > MAX_FILES || directorySize > bytes.length || directoryOffset + directorySize > eocd) throw new Error('The ZIP has too many files or an unsupported directory.');

  const entries = [];
  let offset = directoryOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('The ZIP directory is malformed.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || compressedSize === 0xffffffff || unixType === 0xa000) throw new Error('The ZIP uses an unsupported, encrypted, or linked entry.');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset = end;
    if (name.endsWith('/')) continue;
    if (!name || name.length > 240 || /[\u0000-\u001f\u007f]/.test(name) || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes(':')) throw new Error('The ZIP contains an unsafe file path.');
    const extension = name.split('.').pop().toLowerCase();
    if (['php', 'phtml', 'cgi', 'py', 'rb', 'sh', 'bat', 'cmd', 'exe', 'dll', 'so', 'dylib'].includes(extension)) throw new Error('Server-side or executable files are not allowed.');
    if (size > MAX_FILE_BYTES || (total += size) > MAX_TOTAL_BYTES) throw new Error('The extracted game is too large.');
    entries.push({ name, size });
  }
  if (!entries.some(entry => entry.name === 'index.html')) throw new Error('ZIP must contain index.html at its root.');
  return entries;
}

async function saveArchive(blob, metadata) {
  const response = await fetch(blob.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not read the uploaded archive.');
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('The archive exceeds the 4 MB upload limit.');
    const archive = new Uint8Array(await response.arrayBuffer());
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error('The archive exceeds the 4 MB upload limit.');
  const directory = readDirectory(archive);
  const extracted = unzipSync(archive);
  const extractedFiles = Object.keys(extracted).filter(path => !path.endsWith('/'));
  if (extractedFiles.length !== directory.length) throw new Error('The ZIP contents do not match its directory.');

  const files = [];
  try {
    for (const entry of directory) {
      const content = extracted[entry.name];
      if (!content || content.byteLength !== entry.size) throw new Error('The ZIP contains an invalid file.');
      const extension = entry.name.split('.').pop().toLowerCase();
      const type = MIME_TYPES[extension] || 'application/octet-stream';
      const stored = await put(`games/${metadata.id}/${entry.name}`, content, {
        access: 'public', addRandomSuffix: false, contentType: type, cacheControlMaxAge: 3600,
      });
      files.push({ path: entry.name, url: stored.url, size: content.byteLength, type });
    }
    const index = files.find(file => file.path === 'index.html');
    await redis([
      ['HSET', 'game:' + metadata.id, 'id', metadata.id, 'title', metadata.title, 'description', metadata.description,
        'status', 'pending', 'indexUrl', index.url, 'files', JSON.stringify(files), 'createdAt', String(Date.now())],
      ['SADD', 'games:all', metadata.id], ['PERSIST', 'game:' + metadata.id],
    ]);
  } catch (error) {
    if (files.length) await del(files.map(file => file.url)).catch(() => {});
    throw error;
  } finally {
    await del(blob.url).catch(() => {});
  }
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
    const request = new Request(`https://${host}${req.url || '/api/games/upload'}`, { method: 'POST', headers, body: raw });
    const response = await handleUpload({
      body, request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!/^incoming\/[a-f0-9-]{36}\.zip$/i.test(pathname)) throw new Error('Invalid upload path.');
        const metadata = cleanMetadata(clientPayload);
        if (!pathname.toLowerCase().includes(metadata.id)) throw new Error('Upload metadata does not match its path.');
        const [coverUrl] = await redis([['HGET', 'game:' + metadata.id, 'coverUrl']]);
        if (!coverUrl) throw new Error('Upload a cover image before uploading the game bundle.');
        const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80);
        const [count] = await redis([['INCR', 'game-upload-rate:' + ip], ['EXPIRE', 'game-upload-rate:' + ip, 3600]]);
        if (Number(count) > 5) throw new Error('Upload limit reached. Try again in an hour.');
        const [catalogSize] = await redis([['SCARD', 'games:all']]);
        if (Number(catalogSize) >= 2000) throw new Error('The public game catalog has reached its submission limit.');
        const [reserved] = await redis([['HSETNX', 'game:' + metadata.id, 'status', 'uploading']]);
        if (Number(reserved) !== 1) throw new Error('This game upload has already been used.');
        await redis([['HSET', 'game:' + metadata.id, 'title', metadata.title, 'description', metadata.description], ['EXPIRE', 'game:' + metadata.id, 3600]]);
        return {
          allowedContentTypes: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
          maximumSizeInBytes: MAX_ARCHIVE_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify(metadata),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const metadata = cleanMetadata(tokenPayload);
        await saveArchive(blob, metadata);
      },
    });
    return res.status(200).json(response);
  } catch (error) {
    const message = String(error && error.message || 'Upload could not be processed.').slice(0, 180);
    return res.status(400).json({ error: message });
  }
};

module.exports.config = { api: { bodyParser: false } };
