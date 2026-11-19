module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'no key', detail: 'GROQ_API_KEY missing. Add it in Vercel, then redeploy' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const n = Math.min(Math.max(parseInt(body.n) || 10, 4), 12);
  const themes = {
    mixed: 'a mix of everyday friend-group situations, texting habits, and absurd hypotheticals',
    college: 'campus life, all-nighters, group projects, dorm and cafeteria chaos',
    work: 'office life, meetings that should have been emails, Slack habits, side hustles',
    couples: 'relationship habits, dating, texting, and date-night behavior, kept PG-18+',
    roast: 'playful teasing about habits and quirks, never about looks, body, race, religion, or health'
  };
  const theme = themes[body.theme] || themes.mixed;
  const seed = Math.random().toString(36).slice(2, 8);
  const models = [...new Set([process.env.GROQ_MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].filter(Boolean))];

  let content = null, lastErr = '';
  for (const model of models) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 1,
          max_completion_tokens: 2000, reasoning_effort: 'low',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You write prompts for a "Most likely to" party game. Each prompt starts with "Most likely to", is under 70 characters, funny, specific, and written the way friends actually talk. No slurs, sexual content, politics, or real people. Never repeat ideas. Reply with ONLY a JSON object: {"prompts": ["...", "..."]}'
            },
            { role: 'user', content: `Write ${n} prompts. Theme: ${theme}. Variety seed: ${seed}.` }
          ]
        })
      });
      const d = await r.json();
      if (r.ok) { content = d.choices[0].message.content; break; }
      lastErr = (d.error && d.error.message) || 'HTTP ' + r.status;
    } catch (e) {
      lastErr = 'fetch failed';
    }
  }
  if (content === null) return res.status(502).json({ error: 'upstream', detail: String(lastErr).slice(0, 160) });

  let arr = [];
  try { arr = JSON.parse(content).prompts; } catch (_) { return res.status(502).json({ error: 'parse' }); }

  const seen = new Set();
  const prompts = (Array.isArray(arr) ? arr : [])
    .filter(s => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => /^most likely to/i.test(s) && s.length >= 15 && s.length <= 100)
    .filter(s => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));

  if (prompts.length < 4) return res.status(502).json({ error: 'short' });
  res.status(200).json({ prompts });
};
