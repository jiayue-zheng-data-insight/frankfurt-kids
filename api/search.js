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
  return organic.map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

async function fetchPageText(url, timeoutMs = 8000, maxChars = 3000) {
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
      model: 'claude-sonnet-4-6',   // 64K output tokens vs Haiku's 8K
      max_tokens: 16000,
      system: 'You are a JSON API. Return only valid JSON, no explanations, no markdown.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.content[0].text.trim();
  console.log('[Claude] raw (first 400):', raw.slice(0, 400));
  console.log('[Claude] raw length:', raw.length);
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
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) { console.log('[KV] no credentials'); return null; }
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { console.warn('[KV] get failed:', res.status); return null; }
    const data = await res.json();
    console.log('[KV] get result type:', typeof data.result, 'length:', (data.result||'').length);
    return data.result ?? null;
  } catch (e) {
    console.warn('[KV] get error:', e.message);
    return null;
  }
}

async function kvSet(key, valueStr) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    // Upstash REST: GET-style set with expiry avoids body encoding issues for large values
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: valueStr, ex: 90000 })
    });
    console.log('[KV] set status:', r.status);
  } catch (e) {
    console.warn('[KV] set error:', e.message);
  }
}

// Known Frankfurt kids listing pages — server-rendered
const LISTING_PAGES = [
  { label: 'kindaling.de Frankfurt',     url: 'https://www.kindaling.de/veranstaltungen/frankfurt',                maxChars: 25000 },
  { label: 'rheinmain4family Frankfurt', url: 'https://www.rheinmain4family.de/events/selectedcity/frankfurt.html', maxChars: 12000 },
  { label: 'rheinmain4family general',   url: 'https://www.rheinmain4family.de/veranstaltungen/',                  maxChars: 8000  },
  { label: 'kinderfreizeit-frankfurt',   url: 'https://kinderfreizeit-frankfurt.de/',                              maxChars: 6000  },
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

    const force = !!(req.body && req.body.force);
    const cacheKey = `fk_activities_${todayStr}_v5`;

    // ── KV cache check ──
    if (!force) {
      const cached = await kvGet(cacheKey);
      if (cached) {
        try {
          const activities = JSON.parse(cached);
          if (Array.isArray(activities) && activities.length > 0) {
            console.log(`[KV] hit: ${activities.length} activities`);
            return res.status(200).json({ success: true, activities, cached: true });
          }
        } catch (e) { console.warn('[KV] parse error:', e.message); }
      }
    }
    console.log(`[Search] starting fresh search (force=${force})`);

    const curMonthDE   = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN   = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE  = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN  = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange    = `${curMonthEN} and ${nextMonthEN}`;
    const monthRange   = `${curMonthDE} ${nextMonthDE} 2026`;

    // Step 1: Serper queries + direct listing fetches — in parallel
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
          const text = await fetchPageText(p.url, 10000, p.maxChars);
          return text ? { label: p.label, url: p.url, text } : null;
        })
      ).then(r => r.filter(Boolean))
    ]);

    console.log(`[Search] listing pages: ${listingTexts.map(l => `${l.label}=${l.text.length}chars`).join(', ')}`);
    console.log(`[Search] serper results: ${serperResults.length}`);

    // Deduplicate + sort Serper results
    const seenUrls = new Set(listingTexts.map(l => l.url));
    const uniqueSerper = serperResults
      .filter(r => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; })
      .sort((a, b) => (isDetailUrl(b.url) ? 1 : 0) - (isDetailUrl(a.url) ? 1 : 0));

    // Step 2: Fetch top 12 Serper pages (3000 chars each = controlled size)
    const serperFetched = await Promise.all(
      uniqueSerper.slice(0, 12).map(async r => {
        const text = await fetchPageText(r.url, 6000, 3000);
        return text ? { url: r.url, text } : null;
      })
    );
    const serperPages = serperFetched.filter(Boolean);
    console.log(`[Search] serper pages fetched: ${serperPages.length}`);

    // Build context — listing pages first (most complete), then Serper
    const listingContext = listingTexts.map(l =>
      `[LISTING: ${l.label}]\nURL: ${l.url}\n${l.text}`
    ).join('\n\n---\n\n');

    const serperContext = uniqueSerper.slice(0, 12).map((r, i) => {
      const page = serperPages.find(p => p.url === r.url);
      const content = page ? page.text : `Title: ${r.title}\n${r.snippet}`;
      return `[${i + 1}] URL: ${r.url}\n${content}`;
    }).join('\n\n---\n\n');

    const context = [listingContext, serperContext].filter(Boolean).join('\n\n===\n\n');
    console.log(`[Search] total context length: ${context.length} chars`);

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Include activities from ${tomorrowStr} to ${cutoffStr}.
Only skip an activity if it CLEARLY AND DEFINITIVELY ended before ${tomorrowStr}.
When in doubt about dates, include the activity.

IMPORTANT: Frankfurt am Main only. Skip Mainz, Wiesbaden, Darmstadt, and other cities.

The [LISTING:] sections below are live Frankfurt children's event listing pages — extract EVERY distinct activity you can find. Do not stop early.

PAGE CONTENTS:
${context}

Output a JSON array containing every distinct upcoming activity found. No limit on count. Start with [ end with ]. Raw JSON only.

Each object:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"中文名","description":"中文介绍（一两句）","descriptionEn":"English.","location":"venue, address","dates":"Datum","datesEn":"Date in English","time":"HH:MM or HH:MM-HH:MM or siehe Website","price":"price or siehe Website","priceEn":"price or see website","booking":"domain.de","bookingUrl":"https://full-url","bookingType":"onsite","tags":["Tag"],"tagsZh":["标签"],"ageRange":"3+","ageGroup":"3-5"}

Rules:
- bookingType: "advance" (Anmeldung) | "onsite" (Tageskasse) | "free" (kostenlos) — default "onsite"
- ageGroup: "0-2" | "3-5" | "6-10" | "10+" | "all"
- description Chinese only; descriptionEn English only
- time: "HH:MM" if start only; "HH:MM-HH:MM" if range; "siehe Website" if unknown
- bookingUrl: use the most specific event URL available
- Extract as many activities as possible — do not stop at 10 or 15`;

    const raw = await callClaude(prompt);
    const activities = parseActivities(raw);
    console.log(`[Search] activities parsed: ${activities.length}`);

    if (!Array.isArray(activities) || activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed', raw: raw.slice(0, 500) });
    }

    // Re-assign sequential ids
    activities.forEach((a, i) => { a.id = i + 1; });

    // Save to KV
    await kvSet(cacheKey, JSON.stringify(activities));

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
