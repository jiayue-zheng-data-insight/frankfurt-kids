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

async function fetchPageText(url, timeoutMs = 5000, maxChars = 3000) {
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
      .slice(0, maxChars);
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
      max_tokens: 5000,
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

function isDetailUrl(url) {
  try {
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).length >= 2;
  } catch { return false; }
}

// ── Upstash Redis REST helpers ──
// Env vars auto-injected by Vercel: KV_REST_API_URL, KV_REST_API_TOKEN
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ?? null;
  } catch (e) {
    console.warn('[KV] get error:', e.message);
    return null;
  }
}

async function kvSet(key, value, exSeconds = 90000) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  } catch (e) {
    console.warn('[KV] set error:', e.message);
  }
}

// Known Frankfurt kids event listing pages — server-rendered, always fetched directly
const LISTING_PAGES = [
  { label: 'kindaling.de Frankfurt',     url: 'https://www.kindaling.de/veranstaltungen/frankfurt' },
  { label: 'rheinmain4family Frankfurt', url: 'https://www.rheinmain4family.de/events/selectedcity/frankfurt.html' },
  { label: 'rheinmain4family all',       url: 'https://www.rheinmain4family.de/veranstaltungen/' },
  { label: 'kinderfreizeit-frankfurt',   url: 'https://kinderfreizeit-frankfurt.de/' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + 30);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    // ── Server-side daily KV cache ──
    const cacheKey = `fk_activities_${todayStr}`;
    const cached = await kvGet(cacheKey);
    if (cached) {
      try {
        const activities = typeof cached === 'string' ? JSON.parse(cached) : cached;
        if (Array.isArray(activities) && activities.length > 0) {
          console.log(`[KV] Cache hit for ${todayStr}: ${activities.length} activities`);
          return res.status(200).json({ success: true, activities, cached: true });
        }
      } catch {}
    }
    console.log(`[KV] Cache miss for ${todayStr}, running search`);

    const curMonthDE   = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN   = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE  = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN  = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange    = `${curMonthEN} and ${nextMonthEN}`;
    const monthRange   = `${curMonthDE} ${nextMonthDE} 2026`;

    // Step 1: Serper queries + direct listing page fetches in parallel
    const [serperResults, listingTexts] = await Promise.all([
      Promise.all([
        serperSearch(`site:rausgegangen.de Frankfurt Kinder ${monthRange}`),
        serperSearch(`site:kindaling.de veranstaltungen frankfurt ${monthRange}`),
        serperSearch(`site:rheinmain4family.de Frankfurt Kinder ${monthRange}`),
        serperSearch(`site:frankfurt.de Kinder Veranstaltung ${monthRange}`),
        serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${curMonthDE} 2026`),
        serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${nextMonthDE} 2026`),
      ]).then(r => r.flat()),

      Promise.all(
        LISTING_PAGES.map(async p => {
          const text = await fetchPageText(p.url, 7000, 6000);
          return text ? { label: p.label, url: p.url, text } : null;
        })
      ).then(r => r.filter(Boolean))
    ]);

    console.log(`[Search] ${listingTexts.length}/${LISTING_PAGES.length} listing pages fetched`);

    // Deduplicate Serper results; prefer detail URLs
    const seen = new Set(listingTexts.map(l => l.url));
    const uniqueResults = serperResults
      .filter(r => { if (seen.has(r.url)) return false; seen.add(r.url); return true; })
      .sort((a, b) => (isDetailUrl(b.url) ? 1 : 0) - (isDetailUrl(a.url) ? 1 : 0));

    console.log(`[Search] ${uniqueResults.length} unique Serper URLs`);
    if (uniqueResults.length === 0 && listingTexts.length === 0) {
      return res.status(502).json({ error: 'No results from Serper or listing pages.' });
    }

    // Step 2: Fetch top Serper pages in parallel
    const fetched = await Promise.all(
      uniqueResults.slice(0, 10).map(async r => {
        const text = await fetchPageText(r.url);
        return text ? { url: r.url, snippet: r.snippet, text } : null;
      })
    );
    const serperPages = fetched.filter(Boolean);
    console.log(`[Search] ${serperPages.length}/10 Serper pages fetched`);

    // Build context: listing pages first (most comprehensive), then Serper pages
    const listingContext = listingTexts.map(l =>
      `[LISTING: ${l.label}]\nURL: ${l.url}\n${l.text}`
    ).join('\n\n---\n\n');

    const serperContext = uniqueResults.slice(0, 10).map((r, i) => {
      const page = serperPages.find(p => p.url === r.url);
      const content = page ? page.text : `Title: ${r.title}\n${r.snippet}`;
      return `[SERPER-${i + 1}] URL: ${r.url}\n${content}`;
    }).join('\n\n---\n\n');

    const context = [listingContext, serperContext].filter(Boolean).join('\n\n===\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Include activities happening between ${tomorrowStr} and ${cutoffStr}. Skip only activities that clearly ended before ${tomorrowStr}.

IMPORTANT: Only include activities in Frankfurt am Main (not Mainz, Wiesbaden, Darmstadt, or other cities).

Below are contents from Frankfurt children's event websites. The [LISTING:] sections are authoritative listing pages — extract as many distinct upcoming activities as possible from them. The [SERPER-N] sections are individual event pages.

PAGE CONTENTS:
${context}

Output a JSON array of up to 15 objects. Start with [ end with ]. Raw JSON only.

Each object must have exactly these fields:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名（翻译成中文）","description":"用中文写一两句介绍这个活动。","descriptionEn":"One or two sentences in English.","location":"Exact venue and address from page","dates":"Datum from page","datesEn":"Date in English","time":"HH:MM-HH:MM or see website","price":"price from page or siehe Website","priceEn":"price in English or see website","booking":"domain.de","bookingUrl":"https://full-url-to-event-page","bookingType":"advance","tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+","ageGroup":"3-5"}

Rules:
- bookingUrl: for LISTING entries use the specific event URL if visible in the text, otherwise the listing URL; for SERPER entries use the [SERPER-N] URL
- description in Chinese only; descriptionEn in English only
- nameZh = Chinese translation of name
- tags in English, tagsZh same in Chinese
- time: single "HH:MM" if only start known; "HH:MM-HH:MM" if range; "siehe Website" if unknown
- bookingType: "advance" (Anmeldung/online buchen) | "onsite" (Tageskasse/Eintritt) | "free" (kostenlos) — default "onsite"
- ageGroup: "0-2" | "3-5" | "6-10" | "10+" | "all"
- Skip activities not in Frankfurt am Main
- Skip activities clearly ended before ${tomorrowStr}
- Prefer variety: include different types (museum, outdoor, theatre, sport, workshop, etc.)`;

    const raw = await callClaude(prompt);
    const activities = parseActivities(raw);

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed', raw });
    }

    // Save to KV daily cache (25 hours)
    await kvSet(cacheKey, JSON.stringify(activities), 90000);
    console.log(`[KV] Saved ${activities.length} activities for ${todayStr}`);

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
