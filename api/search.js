async function googleSearch(query, num = 5) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${num}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map(item => ({
    title: item.title,
    snippet: item.snippet,
    url: item.link
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = new Date();
    const nextMonth = new Date(today);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const curMonthDE = today.toLocaleString('de-DE', { month: 'long', year: 'numeric' });
    const nextMonthDE = nextMonth.toLocaleString('de-DE', { month: 'long', year: 'numeric' });
    const curMonthEN = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthEN = nextMonth.toLocaleString('en-GB', { month: 'long', year: 'numeric' });

    // Search Google for real Frankfurt children's events in parallel
    // Cover both current month and next month to capture the full upcoming 30 days
    const queries = [
      `Frankfurt Kinder Veranstaltungen ${curMonthDE}`,
      `Frankfurt Kinder Veranstaltungen ${nextMonthDE}`,
      `children events Frankfurt ${curMonthEN} ${nextMonthEN}`,
      `Frankfurt Familien Ausflug Tipps aktuell`
    ];

    const searchResults = await Promise.all(queries.map(q => googleSearch(q, 5)));
    const allResults = searchResults.flat();

    // Deduplicate by URL
    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    const resultsText = uniqueResults
      .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
      .join('\n\n');

    const prompt = `Extract exactly 6 distinct children's activities in Frankfurt for ${curMonthEN} and ${nextMonthEN} from the search results below. Use the exact URL from the search result as bookingUrl.

SEARCH RESULTS:
${resultsText}

Output a JSON array of exactly 6 objects. Start your response with [ and end with ]. No explanation, no markdown, no prose — raw JSON only.

Schema for each object:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue, Frankfurt address","dates":"Date DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://exact-url-from-search-results","needsBooking":false,"tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}

Rules:
- bookingUrl must be the exact URL from the search result
- If dates/times unknown, use "siehe Website" / "see website"
- needsBooking: true only if snippet mentions reservation required
- Translate names and descriptions into Chinese for nameZh and description
- Pick diverse activity types`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: 'You are a JSON API. Return only valid JSON, no explanations.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error', detail: err });
    }

    const data = await response.json();
    const raw = data.content[0].text.trim();

    // Extract JSON array robustly — find first [ ... ] block
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error('Claude returned non-JSON:', raw);
      return res.status(500).json({ error: 'Claude did not return JSON', raw });
    }
    const activities = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
}
