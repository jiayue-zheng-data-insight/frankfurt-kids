async function googleSearch(query, num = 3) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${num}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[Google] FAILED query="${query}" status=${res.status} body=${body.slice(0, 200)}`);
    return [];
  }
  const data = await res.json();
  const items = data.items || [];
  console.log(`[Google] query="${query}" → ${items.length} results: ${items.map(i => i.link).join(', ')}`);
  return items.map(item => ({ title: item.title, snippet: item.snippet, url: item.link }));
}

// Returns true if a URL looks like a specific event/program page, not just a homepage
function isEventPage(url) {
  try {
    const { pathname } = new URL(url);
    return pathname.length > 1 && pathname !== '/';
  } catch {
    return false;
  }
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
  console.log('[Claude] raw (first 400):', raw.slice(0, 400));
  return raw;
}

function parseActivities(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in Claude response');
  return JSON.parse(raw.slice(start, end + 1));
}

const SYSTEM = 'You are a JSON API. Return only valid JSON, no explanations, no markdown.';

const SCHEMA = `{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue, Frankfurt","dates":"Date DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://venue.de/specific/event/page","needsBooking":false,"tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}`;

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

    // Search specific Frankfurt venues for their event/program pages
    const queries = [
      `zoo-frankfurt.de Kinder Veranstaltungen ${curMonthDE} ${nextMonthDE}`,
      `senckenberg.de Kinder Workshop Programm ${curMonthDE} ${nextMonthDE}`,
      `palmengarten.de Kinder Programm ${curMonthDE} ${nextMonthDE}`,
      `kindermuseum-frankfurt.de Veranstaltungen ${curMonthDE} ${nextMonthDE}`,
      `staedelmuseum.de Kinder Familie Programm ${curMonthDE}`,
      `frankfurt.de Kinder Veranstaltungen Ausflug ${curMonthDE} ${nextMonthDE}`
    ];

    const searchResults = await Promise.all(queries.map(q => googleSearch(q, 3)));
    const allResults = searchResults.flat();

    // Deduplicate by URL, prefer event pages over homepages
    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
    const eventPageResults = uniqueResults.filter(r => isEventPage(r.url));

    console.log(`[Search] total=${uniqueResults.length} eventPages=${eventPageResults.length}`);

    // Use event pages if available, fall back to all results
    const resultsToUse = eventPageResults.length >= 3 ? eventPageResults : uniqueResults;

    let activities;

    if (resultsToUse.length > 0) {
      const resultsText = resultsToUse
        .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
        .join('\n\n');

      const prompt = `Extract up to 6 distinct real children's activities in Frankfurt for ${dateRange} from the search results below.

SEARCH RESULTS:
${resultsText}

Output a JSON array of up to 6 objects. Start with [ end with ]. Raw JSON only, no prose.

Schema: ${SCHEMA}

Rules:
- bookingUrl MUST be the exact URL from the search result — a specific event or program page (e.g. /veranstaltungen/...), NOT a bare homepage like "https://www.zoo-frankfurt.de"
- If a result is just a homepage with no event path, skip it
- If dates/times not found in snippet, use "siehe Website" / "see website"
- needsBooking: true only if snippet mentions reservation/Anmeldung required
- Translate names and descriptions into Chinese for nameZh and description
- Pick diverse activity types across different venues`;

      const raw = await callClaude(SYSTEM, prompt);
      activities = parseActivities(raw);
      console.log(`[Search] parsed ${activities.length} activities from Google results`);

    } else {
      // Fallback: Claude generates from knowledge — clearly mark as unverified
      console.warn('[Search] Google returned 0 usable results, falling back to Claude generation');
      const prompt = `List 6 real children's activities at Frankfurt venues for ${dateRange}. Use: Frankfurt Zoo, Senckenberg Museum, Städel Museum, Palmengarten, Kindermuseum Frankfurt.

Output a JSON array of exactly 6 objects. Start with [ end with ]. Raw JSON only, no prose.

Schema: ${SCHEMA}

Rules:
- bookingUrl: use a plausible deep link to the venue's events/program page (e.g. https://www.zoo-frankfurt.de/veranstaltungen), NOT the bare homepage
- Translate names/descriptions into Chinese
- Pick diverse activity types`;

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
