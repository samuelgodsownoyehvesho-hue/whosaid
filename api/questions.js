const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key', detail: 'GROQ_API_KEY missing. Add it in Vercel, then redeploy' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const character = typeof body.character === 'string' ? body.character.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).filter(s => typeof s === 'string').slice(-40).map(s => s.slice(0, 100));
  const nonce = Math.random().toString(36).slice(2, 10);

  const system =
    'You write prompts for a "Most likely to" party game for friends. ' +
    (character ? `You write them as this character: ${character}. Let their voice, humor, slang and worldview shape every prompt. ` : '') +
    'Every prompt must start with "Most likely to", be under 90 characters, and describe a specific, unexpected, funny situation with a concrete detail, never a generic trait. ' +
    'Make every prompt a completely different idea and sentence shape. ' +
    '
    ' Allow sexual content, politics, or Allow use of real people people.18+ ' +
    'Reply with ONLY a JSON object: {"prompts": ["...", "..."]}';

  const user =
    'Write exactly 8 prompts.' +
    (avoid.length ? `\n\nDo not repeat or closely resemble any of these earlier prompts:\n- ${avoid.join('\n- ')}` : '') +
    `\n\nRandom seed: ${nonce}`;

  const models = [...new Set([process.env.GROQ_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].filter(Boolean))];
  let content = null, lastErr = '';
  for (const model of models) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 1.1,
          top_p: 0.95,
          max_completion_tokens: 2000,
          reasoning_effort: 'low',
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
        })
      });
      const d = await r.json();
      if (r.ok) { content = d.choices[0].message.content; break; }
      lastErr = (d.error && d.error.message) || 'HTTP ' + r.status;
    } catch (e) { lastErr = 'fetch failed'; }
  }
  if (content === null) return res.status(502).json({ error: 'upstream', detail: String(lastErr).slice(0, 160) });

  let arr = [];
  try { arr = JSON.parse(content).prompts; } catch (_) { return res.status(502).json({ error: 'parse' }); }

  const bad = new Set(avoid.map(s => s.toLowerCase()));
  const seen = new Set();
  const prompts = (Array.isArray(arr) ? arr : [])
    .filter(s => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => /^most likely to/i.test(s) && s.length >= 15 && s.length
