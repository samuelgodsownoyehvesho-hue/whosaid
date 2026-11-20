const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const handler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key', detail: 'GROQ_API_KEY missing. Add it in Vercel, then redeploy' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const character = typeof body.character === 'string' ? body.character.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const avoid = (Array.isArray(body.avoid) ? body.avoid : []).filter(s => typeof s === 'string').slice(-40).map(s => s.slice(0, 100));
  const nonce = Math.random().toString(36).slice(2, 10);
  const adult = body.adult === true;
  const names = (Array.isArray(body.names) ? body.names : []).filter(x => typeof x === 'string').map(x => x.replace(/[^\p{L}\p{N} '.-]/gu, '').trim().slice(0, 20)).filter(Boolean).slice(0, 12);

  const system =
    'You write prompts for a "Most likely to" party game that friends play together in person. ' +
    (character ? `You write them as this character: ${character}. Let their voice and humor shape every prompt. ` : '') +
    'Each prompt must start with "Most likely to", be under 70 characters, and be ONE short clause. Never chain two ideas with "and". ' +
    'Write realistic, relatable things a real person could actually do. No absurd or surreal scenarios, no random objects, no animals, no fantasy. ' +
    'Each prompt should make a different person in the group come to mind. Vary the topics a lot. ' +
    (adult
      ? 'This is an 18+ adults-only game night. Be bold, cheeky and a bit filthy: dating, hookups, flirting, drinking, hangovers, jealousy, bad late-night decisions, embarrassing intimate moments, crude humor and profanity are all fine. Keep it suggestive, never explicit or graphic. ' +
        (names.length ? `The players are: ${names.join(', ')}. Use one of these names inside a prompt when it makes it funnier. ` : '') +
        'You may also mention famous public figures as a joke comparison, but never make sexual claims about them or accuse any real person of crimes. No minors, no slurs, no jokes that target a race, religion or group. ' +
        'Style examples (never reuse them): "Most likely to text back at 3am after three drinks", "Most likely to get a stranger\'s number at a wedding", "Most likely to cry over someone who ghosted them once". '
      : 'Keep it clean and friendly. No slurs, sexual content, politics, or real people. Style examples (never reuse them): "Most likely to cry during a group project", "Most likely to order for the whole table", "Most likely to forget their own wallet". ') +
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
    .filter(s => /^most likely to/i.test(s) && s.length >= 15 && s.length <= 110)
    .filter(s => !bad.has(s.toLowerCase()) && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));

  if (prompts.length < 6) return res.status(502).json({ error: 'short' });
  res.status(200).json({ prompts: shuffle(prompts) });
};

module.exports = async (req, res) => {
  try { await handler(req, res); }
  catch (e) { res.status(500).json({ error: 'crash', detail: String((e && e.message) || e).slice(0, 200) }); }
};
