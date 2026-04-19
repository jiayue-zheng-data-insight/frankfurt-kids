async function googleSearch(query, num = 5) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${num}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[Google] query="${query}" status=${res.status} body=${body}`);
    return [];
  }
  const data = await res.json();
  const items = data.items || [];
  console.log(`[Google] query="${query}" → ${items.length} results`);
  return items.map(item => ({
    title: item.title,
    snippet: item.snippet,
    url: item.link
  }));
}

async function callClaude(system, prompt) {
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
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const raw = data.content[0].text.trim();
  console.log('[Claude] raw response:', raw.slice(0, 300));
  return raw;
}

function parseActivities(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response');
  return JSON.parse(raw.slice(start, end + 1));
}

const SYSTEM = 'You are a JSON API. Return only valid JSON, no explanations, no markdown.';

const SCHEMA = `{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue, Frankfurt","dates":"Date DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://...","needsBooking":false,"tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}`;

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
    const dateRange = `${curMonthEN} and ${nextMonthEN}`;

    // Step 1: Google search — cover current + next month
    const queries = [
      `Frankfurt Kinder Veranstaltungen ${curMonthDE}`,
      `Frankfurt Kinder Veranstaltungen ${nextMonthDE}`,
      `children events Frankfurt ${curMonthEN} ${nextMonthEN}`,
      `Frankfurt Familien Ausflug Tipps aktuell`
    ];

    const searchResults = await Promise.all(queries.map(q => googleSearch(q, 5)));
    const allResults = searchResults.flat();

    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    console.log(`[Search] total unique results: ${uniqueResults.length}`);

    let activities;

    if (uniqueResults.length > 0) {
      // Step 2a: Claude extracts activities from real search results
      const resultsText = uniqueResults
        .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
        .join('\n\n');

      const prompt = `Extract exactly 6 distinct children's activities in Frankfurt for ${dateRange} from the search results below. Use the exact URL from the search result as bookingUrl.

SEARCH RESULTS:
${resultsText}

Output a JSON array of exactly 6 objects. Start with [ end with ]. Raw JSON only, no prose.

Schema: ${SCHEMA}

Rules:
- bookingUrl must be the exact URL from the search result
- If dates/times unknown, use "siehe Website" / "see website"
- needsBooking: true only if snippet mentions reservation required
- Translate names/descriptions into Chinese for nameZh and description
- Pick diverse activity types`;

      const raw = await callClaude(SYSTEM, prompt);
      activities = parseActivities(raw);
      console.log(`[Search] parsed ${activities.length} activities from Google results`);

    } else {
      // Step 2b: Fallback — Claude generates activities from its own knowledge
      console.warn('[Search] Google returned 0 results, falling back to Claude generation');
      const prompt = `List 6 real children's activities in Frankfurt am Main for ${dateRange}. Use well-known venues: Frankfurt Zoo, Senckenberg Museum, Städel Museum, Palmengarten, Kindermuseum Frankfurt, Römerberg area.

Output a JSON array of exactly 6 objects. Start with [ end with ]. Raw JSON only, no prose.

Schema: ${SCHEMA}

Rules:
- bookingUrl should be the real homepage of the venue (e.g. https://www.zoo-frankfurt.de)
- Pick diverse activity types (museum, outdoor, show, sport, etc.)
- Translate names/descriptions into Chinese for nameZh and description`;

      const raw = await callClaude(SYSTEM, prompt);
      activities = parseActivities(raw);
      console.log(`[Search] fallback generated ${activities.length} activities`);
    }

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed', detail: 'Claude returned an empty array' });
    }

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
