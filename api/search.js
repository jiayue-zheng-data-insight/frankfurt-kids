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

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + 30);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const curMonthDE = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange = `${curMonthEN} and ${nextMonthEN}`;

    const results = await Promise.all([
      serperSearch(`Kinderveranstaltungen Frankfurt ${curMonthDE} 2026`),
      serperSearch(`Kinderveranstaltungen Frankfurt ${nextMonthDE} 2026`)
    ]).then(r => r.flat());

    // Deduplicate by URL
    const seen = new Set();
    const uniqueResults = results.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    console.log(`[Search] total unique results: ${uniqueResults.length}`);

    if (uniqueResults.length === 0) {
      return res.status(502).json({ error: 'Serper returned no results. Check SERPER_API_KEY in Vercel.' });
    }

    const resultsText = uniqueResults
      .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
      .join('\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities.

Today is ${tomorrowStr === cutoffStr ? tomorrowStr : tomorrowStr} (tomorrow). Only include activities happening between ${tomorrowStr} and ${cutoffStr}. Skip activities that start after ${cutoffStr} or ended before ${tomorrowStr}.

Below are real Google search results. Extract up to 6 distinct activities within that date window.

SEARCH RESULTS:
${resultsText}

Output a JSON array of up to 6 objects. Start with [ end with ]. Raw JSON only.

Each object must have exactly these fields:
{"id":1,"emoji":"🦁","name":"Event name in original language","nameZh":"活动中文名（翻译成中文）","description":"用中文写一两句介绍这个活动。","descriptionEn":"One or two sentences in English describing the activity.","location":"Venue, Frankfurt","dates":"Datum DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://exact-url-from-results","bookingType":"advance","tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}

Rules:
- IMPORTANT: skip any activity whose dates fall entirely outside ${tomorrowStr}–${cutoffStr}
- bookingUrl must be the exact URL from the search results — do not invent URLs
- description MUST be written in Chinese (中文) — never leave German or English text in this field
- descriptionEn MUST be written in English — never leave German text in this field
- nameZh MUST be a Chinese translation of the event name
- tags should be in English, tagsZh should be the same tags translated to Chinese
- If dates/times/price not found in snippet, use "siehe Website" / "see website"
- bookingType must be one of three values:
    "advance" — must book/register online in advance (snippet mentions: Anmeldung erforderlich, Tickets kaufen, im Voraus buchen)
    "onsite"  — tickets needed but can be bought at the door (snippet mentions: Tageskasse, Eintritt kaufen, Tickets vor Ort, Eintrittskarte)
    "free"    — free entry or no ticket needed (snippet mentions: freier Eintritt, ohne Anmeldung, kostenlos, keine Reservierung)
    When in doubt (snippet gives no booking info), use "onsite" as the safe default
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
