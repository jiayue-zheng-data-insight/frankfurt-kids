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

    const prompt = `You are helping a Chinese family in Frankfurt discover children's activities for ${curMonthEN} and ${nextMonthEN} (the upcoming 30 days).

Below are real Google search results about Frankfurt children's events. Extract exactly 6 distinct, specific activities from these results. Prefer results that mention concrete venues, dates, or times. Use the exact URL from the search result as bookingUrl.

SEARCH RESULTS:
${resultsText}

Return ONLY a JSON array of 6 activities, no other text:
[{"id":1,"emoji":"🦁","name":"Event name in German/English","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue name and Frankfurt address","dates":"Date in German format","datesEn":"Date in English format","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://exact-url-from-search-results","needsBooking":false,"tags":["Tag1","Tag2"],"tagsZh":["标签1","标签2"],"ageRange":"3+"}]

Rules:
- Use the exact URL from the search result for bookingUrl
- If dates/times are not in the search results, omit or write "see website"
- needsBooking: true only if the snippet mentions booking/reservation required
- Translate all names and descriptions into Chinese for nameZh and description fields
- Pick diverse activity types (museum, outdoor, show, sport, etc.)`;

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
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error', detail: err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const activities = JSON.parse(clean);

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
}
