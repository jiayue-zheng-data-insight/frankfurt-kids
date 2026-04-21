async function serperSearch(query, num = 10) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, gl: 'de', hl: 'de', num })
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Serper] FAILED status=${res.status} body=${body.slice(0, 300)}`);
    return [];
  }
  const data = JSON.parse(body);
  const organic = data.organic || [];
  console.log(`[Serper] "${query}" → ${organic.length} results`);
  organic.forEach(r => console.log(`  • ${r.link}`));
  return organic.map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

async function fetchPageText(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrankfurtKidsBot/1.0)' }
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[Fetch] ${url} → ${res.status}`); return null; }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
    console.log(`[Fetch] ${url} → ${text.length} chars`);
    return text;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[Fetch] ${url} → ${e.message}`);
    return null;
  }
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
      max_tokens: 4096,
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

// Returns true if a URL looks like a specific event page, not a generic listing
function isDetailUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).length >= 2;
  } catch { return false; }
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

    const curMonthDE   = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN   = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE  = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN  = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange    = `${curMonthEN} and ${nextMonthEN}`;

    const monthRange = `${curMonthDE} ${nextMonthDE} 2026`;

    // Step 1: Six Serper queries in parallel
    // site: queries go directly to indexed event detail pages on known Frankfurt event sites
    const allRaw = await Promise.all([
      serperSearch(`site:rausgegangen.de Frankfurt Kinder ${monthRange}`),
      serperSearch(`site:rheinmain4family.de Frankfurt Kinder Veranstaltung ${monthRange}`),
      serperSearch(`site:frankfurt.de Kinder Veranstaltung ${monthRange}`),
      serperSearch(`site:kinderfreizeit-frankfurt.de ${monthRange}`),
      serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${curMonthDE} 2026`),
      serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${nextMonthDE} 2026`)
    ]).then(r => r.flat());

    // Deduplicate; sort so detail-looking URLs come first
    const seen = new Set();
    const uniqueResults = allRaw
      .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
      .sort((a, b) => (isDetailUrl(b.url) ? 1 : 0) - (isDetailUrl(a.url) ? 1 : 0));

    console.log(`[Search] ${uniqueResults.length} unique URLs (${uniqueResults.filter(r => isDetailUrl(r.url)).length} detail-looking)`);
    if (uniqueResults.length === 0) {
      return res.status(502).json({ error: 'Serper returned no results. Check SERPER_API_KEY.' });
    }

    // Step 2: Fetch pages in parallel (top 10, prefer detail URLs)
    const fetched = await Promise.all(
      uniqueResults.slice(0, 10).map(async r => {
        const text = await fetchPageText(r.url);
        return text ? { url: r.url, snippet: r.snippet, text } : null;
      })
    );
    const pages = fetched.filter(Boolean);
    console.log(`[Search] ${pages.length}/10 pages fetched`);

    // Build context — if page text available use it, else fall back to snippet
    const context = uniqueResults.slice(0, 10).map((r, i) => {
      const page = pages.find(p => p.url === r.url);
      const content = page ? page.text : `Title: ${r.title}\n${r.snippet}`;
      return `[${i + 1}] URL: ${r.url}\n${content}`;
    }).join('\n\n---\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Include activities happening between ${tomorrowStr} and ${cutoffStr}. Skip only activities that clearly ended before ${tomorrowStr}.

IMPORTANT: Only include activities in Frankfurt am Main. Skip any activity in Mainz, Wiesbaden, Darmstadt, or other cities.

Below are real web pages about Frankfurt children's events. Extract up to 10 distinct activities.

PAGE CONTENTS:
${context}

Output a JSON array of up to 10 objects. Start with [ end with ]. Raw JSON only.

Each object must have exactly these fields:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名（翻译成中文）","description":"用中文写一两句介绍这个活动。","descriptionEn":"One or two sentences in English.","location":"Exact venue and address from page","dates":"Datum from page","datesEn":"Date in English","time":"HH:MM-HH:MM or see website","price":"price from page or siehe Website","priceEn":"price in English or see website","booking":"domain.de","bookingUrl":"https://exact-url-from-list-above","bookingType":"advance","tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}

Rules:
- bookingUrl MUST be the exact [N] URL from the list above for that activity — do not use homepage-level URLs
- If the URL is a listing page (e.g. /events or /veranstaltungen without a specific event slug), try to find a more specific link mentioned in the page text; otherwise use the URL as-is
- description in Chinese only; descriptionEn in English only; never leave German text in these fields
- nameZh = Chinese translation of name
- tags in English, tagsZh same in Chinese
- time: if only start time known write "HH:MM", not "HH:MM-HH:MM"; if range known write "HH:MM-HH:MM"; if unknown write "siehe Website"
- bookingType: "advance" (Anmeldung/online buchen) | "onsite" (Tageskasse/Eintritt) | "free" (kostenlos/freier Eintritt) — default "onsite"
- Skip activities not in Frankfurt am Main
- Skip activities clearly ended before ${tomorrowStr}`;

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
