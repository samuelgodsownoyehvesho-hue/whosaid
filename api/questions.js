module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const n = Math.min(Math.max(parseInt(body.n) || 8, 4), 12);
  const themes = {
    mixed: 'a mix of everyday friend-group situations, texting habits, and absurd hypotheticals',
    college: 'campus life, all-nighters, group projects, dorm and cafeteria chaos',
    work: 'office life, meetings that should have been emails, Slack habits, side hustles',
    couples: 'relationship habits, dating, texting, and date-night behavior, kept PG-18+',
    roast: 'playful teasing about habits and quirks, never about looks, body, race, religion, or health'
  };
  const theme = themes[body.theme] || themes.mixed;
  const seed = Math.random().toString(36).slice(2, 8);

  let d;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        temperature: 1,
        max_tokens: 700,
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
    if (!r.ok) return res.status(502).json({ error: 'upstream' });
    d = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'upstream' });
  }

  let arr = [];
  try {
    arr = JSON.parse(d.choices[0].message.content).prompts;
  } catch (_) {
    return res.status(502).json({ error: 'parse' });
  }

  const seen = new Set();
  const prompts = (Array.isArray(arr) ? arr : [])
    .filter(s => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => /^most likely to/i.test(s) && s.length >= 15 && s.length <= 90)
    .filter(s => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));

  if (prompts.length < 4) return res.status(502).json({ error: 'short' });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ prompts });
};
