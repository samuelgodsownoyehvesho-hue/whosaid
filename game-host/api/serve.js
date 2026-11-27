const MAIN_API = 'https://whosaid.vercel.app/api/games';

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed.');

  const game = String(req.query.game || '').toLowerCase();
  const pathname = String(req.query.path || '');
  if (!/^[a-f0-9-]{36}$/.test(game) || !pathname || pathname.length > 240 || pathname.startsWith('/') || pathname.includes('\\') || pathname.split('/').some(part => !part || part === '.' || part === '..')) {
    return res.status(400).send('Invalid game file path.');
  }

  const upstreamUrl = new URL(MAIN_API);
  upstreamUrl.searchParams.set('action', 'asset');
  upstreamUrl.searchParams.set('id', game);
  upstreamUrl.searchParams.set('path', pathname);
  try {
    const upstream = await fetch(upstreamUrl, { method: req.method, signal: AbortSignal.timeout(12000) });
    const body = req.method === 'HEAD' ? null : Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    if (!upstream.ok) return res.send(body || 'Game file unavailable.');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', upstream.headers.get('content-disposition') || 'inline; filename="game-file"');
    if (body) res.setHeader('Content-Length', String(body.byteLength));
    return res.send(body);
  } catch (_) {
    return res.status(502).send('Game file could not be loaded.');
  }
};
