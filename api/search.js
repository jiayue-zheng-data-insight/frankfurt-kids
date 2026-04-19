async function serperSearch(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY
    },
    body: JSON.stringify({ q: query, gl: 'de', hl: 'de', num: 10 })
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Serper] FAILED status=${res.status} body=${body.slice(0, 300)}`);
    return [];
  }
  const data = JSON.parse(body);
  const organic = data.organic || [];
  console.log(`[Serper] query="${query}" → ${organic.length} results`);
  organic.forEach(r => console.log(`  • ${r.link}`));
  return organic.map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      system: 'You are a JSON API. Return only valid JSON, no explanations, no markdown.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.content[0].text.trim();
  console.log('[Claude] raw (first 400):', raw.slice(0, 400));
  return raw;
}

function parseActivities(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in Claude response');
  return JSON.parse(raw.slice(start, end + 1));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const curMonthEN = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const nextMonthEN = nextMonth.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange = `${curMonthEN} and ${nextMonthEN}`;

    const results = await serperSearch('Kinderveranstaltungen Frankfurt 2026');

    if (results.length === 0) {
      return res.status(502).json({ error: 'Serper returned no results. Check SERPER_API_KEY in Vercel.' });
    }

    const resultsText = results
      .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
      .join('\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Below are real Google search results about Frankfurt children's events. Extract up to 6 distinct activities.

SEARCH RESULTS:
${resultsText}

Output a JSON array of up to 6 objects. Start with [ end with ]. Raw JSON only.

Each object must have exactly these fields:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue, Frankfurt","dates":"Datum DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://exact-url-from-results","needsBooking":false,"tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}

Rules:
- bookingUrl must be the exact URL from the search results — do not invent URLs
- If dates/times/price not found, use "siehe Website" / "see website"
- needsBooking: true only if the snippet mentions Anmeldung or reservation required
- Translate name and description into Chinese for nameZh and description fields
- Choose diverse activity types`;

    const raw = await callClaude(prompt);
    const activities = parseActivities(raw);

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed', raw });
    }

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
