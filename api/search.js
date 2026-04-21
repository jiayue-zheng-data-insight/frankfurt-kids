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

async function fetchPageText(url, timeoutMs = 10000, maxChars = 0) {
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
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (maxChars > 0) text = text.slice(0, maxChars);
    console.log(`[Fetch] ${url} → ${text.length} chars`);
    return text;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[Fetch] ${url} → ${e.message}`);
    return null;
  }
}

const CLAUDE_SYSTEM = 'You are a JSON API. Return only valid JSON, no explanations, no markdown.';

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
      max_tokens: 8096,
      system: CLAUDE_SYSTEM,
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

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    // Upstash Redis REST: POST single command as JSON array
    await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, value, 'EX', 90000])
    });
  } catch (e) {
    console.warn('[KV] set error:', e.message);
  }
}

// Known Frankfurt kids listing pages — server-rendered, fetched directly every time
// maxChars: generous but bounded so Claude API requests stay under ~200KB
const LISTING_PAGES = [
  { label: 'kindaling.de Frankfurt',      url: 'https://www.kindaling.de/veranstaltungen/frankfurt',               maxChars: 30000 },
  { label: 'rheinmain4family Frankfurt',  url: 'https://www.rheinmain4family.de/events/selectedcity/frankfurt.html', maxChars: 15000 },
  { label: 'rheinmain4family general',    url: 'https://www.rheinmain4family.de/veranstaltungen/',                 maxChars: 10000 },
  { label: 'kinderfreizeit-frankfurt',    url: 'https://kinderfreizeit-frankfurt.de/',                             maxChars: 8000  },
];

function buildPrompt(context, dateRange, tomorrowStr, cutoffStr, sourceLabel) {
  return `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Include activities from ${tomorrowStr} to ${cutoffStr}. Only skip if CLEARLY ended before ${tomorrowStr}.

IMPORTANT: Frankfurt am Main only. Skip Mainz, Wiesbaden, Darmstadt, and any other city.

Source: ${sourceLabel}

PAGE CONTENTS:
${context}

Extract EVERY distinct upcoming activity. Output a JSON array — no limit on count. Start with [ end with ]. Raw JSON only.

Each object:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"中文名","description":"中文介绍（一两句）","descriptionEn":"English description.","location":"venue and address","dates":"Datum","datesEn":"Date in English","time":"HH:MM or HH:MM-HH:MM or siehe Website","price":"price or siehe Website","priceEn":"price in English or see website","booking":"domain.de","bookingUrl":"https://full-url","bookingType":"advance","tags":["Tag"],"tagsZh":["标签"],"ageRange":"3+","ageGroup":"3-5"}

Rules:
- bookingType: "advance" | "onsite" | "free" (default "onsite")
- ageGroup: "0-2" | "3-5" | "6-10" | "10+" | "all"
- description Chinese only; descriptionEn English only
- time: single HH:MM if only start; HH:MM-HH:MM if range; "siehe Website" if unknown
- Skip non-Frankfurt; only skip past events if CLEARLY ended before ${tomorrowStr}`;
}

function deduplicateActivities(lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    for (const a of list) {
      // Deduplicate by normalised name (lowercase, strip spaces)
      const key = (a.name || '').toLowerCase().replace(/\s+/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(a);
    }
  }
  // Re-assign sequential ids
  result.forEach((a, i) => { a.id = i + 1; });
  return result;
}

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

    // Cache key includes version suffix — bump to v3 to bust old cached results
    const force = req.body && req.body.force === true;
    const cacheKey = `fk_activities_${todayStr}_v4`;
    const cached = force ? null : await kvGet(cacheKey);
    if (cached) {
      try {
        const activities = JSON.parse(cached);
        if (Array.isArray(activities) && activities.length > 0) {
          console.log(`[KV] Cache hit for ${todayStr}: ${activities.length} activities`);
          return res.status(200).json({ success: true, activities, cached: true });
        }
      } catch {}
    }
    console.log(`[KV] Cache miss for ${todayStr}_v3, running search`);

    const curMonthDE   = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN   = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE  = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN  = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange    = `${curMonthEN} and ${nextMonthEN}`;
    const monthRange   = `${curMonthDE} ${nextMonthDE} 2026`;

    // Step 1: Serper queries + listing page fetches in parallel — no char limits
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
          const text = await fetchPageText(p.url, 12000, p.maxChars);
          return text ? { label: p.label, url: p.url, text } : null;
        })
      ).then(r => r.filter(Boolean))
    ]);

    console.log(`[Search] ${listingTexts.length}/${LISTING_PAGES.length} listing pages, ${serperResults.length} Serper results`);

    // Deduplicate Serper URLs
    const seenUrls = new Set(listingTexts.map(l => l.url));
    const uniqueSerper = serperResults
      .filter(r => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; })
      .sort((a, b) => (isDetailUrl(b.url) ? 1 : 0) - (isDetailUrl(a.url) ? 1 : 0));

    if (uniqueSerper.length === 0 && listingTexts.length === 0) {
      return res.status(502).json({ error: 'No results from Serper or listing pages.' });
    }

    // Step 2: Fetch Serper pages — no limit on count, no char limit
    const serperPagesFetched = await Promise.all(
      uniqueSerper.map(async r => {
        const text = await fetchPageText(r.url);
        return text ? { url: r.url, snippet: r.snippet, text } : null;
      })
    );
    const serperPages = serperPagesFetched.filter(Boolean);
    console.log(`[Search] ${serperPages.length}/${uniqueSerper.length} Serper pages fetched`);

    // Step 3: Two parallel Claude calls — listing pages and Serper pages separately
    // This doubles the effective output token budget (2 × 8096)
    const listingContext = listingTexts.map(l =>
      `[LISTING: ${l.label}]\nURL: ${l.url}\n${l.text}`
    ).join('\n\n---\n\n');

    const serperContext = uniqueSerper.map((r, i) => {
      const page = serperPages.find(p => p.url === r.url);
      const content = page ? page.text : `Title: ${r.title}\n${r.snippet}`;
      return `[${i + 1}] URL: ${r.url}\n${content}`;
    }).join('\n\n---\n\n');

    const [listingActivities, serperActivities] = await Promise.all([
      listingContext
        ? callClaude(buildPrompt(listingContext, dateRange, tomorrowStr, cutoffStr, 'Direct listing pages (kindaling.de, rheinmain4family.de)')).then(parseActivities).catch(e => { console.error('[Claude-listing]', e.message); return []; })
        : Promise.resolve([]),
      serperContext
        ? callClaude(buildPrompt(serperContext, dateRange, tomorrowStr, cutoffStr, 'Google search results (rausgegangen.de, frankfurt.de, etc.)')).then(parseActivities).catch(e => { console.error('[Claude-serper]', e.message); return []; })
        : Promise.resolve([]),
    ]);

    console.log(`[Claude] listing=${listingActivities.length} serper=${serperActivities.length}`);

    const activities = deduplicateActivities([listingActivities, serperActivities]);
    console.log(`[Search] Total after dedup: ${activities.length}`);

    if (activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed from either source' });
    }

    // Save to KV daily cache
    await kvSet(cacheKey, JSON.stringify(activities));
    console.log(`[KV] Saved ${activities.length} activities for ${todayStr}_v3`);

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('[Search] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
