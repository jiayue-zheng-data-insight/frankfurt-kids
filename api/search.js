async function googleSearch(query, num = 5) {
  const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=${num}`;
  console.log(`[Google] calling: ${apiUrl.replace(process.env.GOOGLE_API_KEY, 'KEY_HIDDEN')}`);
  const res = await fetch(apiUrl);
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Google] FAILED query="${query}" status=${res.status} body=${body.slice(0, 500)}`);
    return [];
  }
  const data = JSON.parse(body);
  const items = data.items || [];
  console.log(`[Google] query="${query}" → ${items.length} results (totalResults=${data.searchInformation?.totalResults})`);
  items.forEach(item => console.log(`  • ${item.link}`));
  return items.map(item => ({ title: item.title, snippet: item.snippet, url: item.link }));
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

const SCHEMA = `{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Venue, Frankfurt","dates":"Date DE","datesEn":"Date EN","time":"HH:MM-HH:MM","price":"Erw. €X / Kinder €X","priceEn":"Adults €X / Children €X","booking":"website.de","bookingUrl":"https://exact-url-from-search-results","needsBooking":false,"tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}`;

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

    const queries = [
      'Frankfurt Kinder Veranstaltungen Wochenende aktuell',
      'Frankfurt Kinder Ausflug Tipps aktuell',
      'was ist los Frankfurt Kinder Familie Wochenende',
      'Frankfurt Familien Freizeitangebote Kinder'
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

    if (uniqueResults.length === 0) {
      return res.status(502).json({
        error: 'Google search returned no results. Check GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID in Vercel, and confirm the CSE is set to search the entire web.'
      });
    }

    const resultsText = uniqueResults
      .map((r, i) => `[${i + 1}] Title: ${r.title}\nSnippet: ${r.snippet}\nURL: ${r.url}`)
      .join('\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's weekend activities for ${dateRange}.

Below are real Google search results. Extract up to 6 distinct children's activities from these results.

SEARCH RESULTS:
${resultsText}

Output a JSON array of up to 6 objects. Start with [ end with ]. Raw JSON only, no prose.

Schema: ${SCHEMA}

Rules:
- bookingUrl must be the exact URL from the search result above — do not invent or modify URLs
- Prefer specific event/program pages over bare homepages
- If dates/times not in snippet, use "siehe Website" / "see website"
- needsBooking: true only if snippet mentions Anmeldung/reservation required
- Translate names and descriptions into Chinese for nameZh and description
- Pick diverse activity types (museum, outdoor, show, workshop, sport, etc.)`;

    const raw = await callClaude(SYSTEM, prompt);
    const activities = parseActivities(raw);
    console.log(`[Search] parsed ${activities.length} activities`);

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed from search results', raw });
    }

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
