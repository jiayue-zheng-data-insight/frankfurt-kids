async function serperSearch(query, num = 10) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, gl: 'de', hl: 'de', num })
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Serper] FAILED ${res.status}: ${body.slice(0, 200)}`);
    return [];
  }
  const data = JSON.parse(body);
  const organic = data.organic || [];
  console.log(`[Serper] "${query}" → ${organic.length}`);
  return organic.map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

async function fetchPageText(url, timeoutMs = 6000, maxChars = 3000) {
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
  console.log(`[Claude] prompt length: ${prompt.length} chars`);
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
      system: 'You are a JSON API. Return only valid JSON, no explanations, no markdown.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.content[0].text.trim();
  console.log(`[Claude] response: ${raw.length} chars, starts: ${raw.slice(0, 80)}`);
  return raw;
}

function parseActivities(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found');
  return JSON.parse(raw.slice(start, end + 1));
}

function isDetailUrl(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).length >= 2; }
  catch { return false; }
}

// ── Upstash Redis REST ──
async function kvGet(key) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) return null;
  try {
    const r = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) return;
  try {
    await fetch(`${base}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/90000`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (e) { console.warn('[KV] set error:', e.message); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = (() => { const d = new Date(today); d.setDate(d.getDate()+1); return d.toISOString().split('T')[0]; })();
    const cutoffStr   = (() => { const d = new Date(today); d.setDate(d.getDate()+30); return d.toISOString().split('T')[0]; })();

    const force = !!(req.body && req.body.force);
    const cacheKey = `fk_v6_${todayStr}`;

    if (!force) {
      const cached = await kvGet(cacheKey);
      if (cached) {
        try {
          const acts = JSON.parse(cached);
          if (Array.isArray(acts) && acts.length > 0) {
            console.log(`[KV] hit: ${acts.length} activities`);
            return res.status(200).json({ success: true, activities: acts, cached: true });
          }
        } catch {}
      }
    }
    console.log(`[Search] start (force=${force})`);

    const curMonthDE  = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN  = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMo      = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE = nextMo.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN = nextMo.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const monthRange  = `${curMonthDE} ${nextMonthDE} 2026`;
    const dateRange   = `${curMonthEN} and ${nextMonthEN}`;

    // ── Step 1: Serper queries + kindaling direct fetch — parallel ──
    const [serperRaw, kindText, kinderText] = await Promise.all([
      Promise.all([
        serperSearch(`site:rausgegangen.de Frankfurt Kinder ${monthRange}`),
        serperSearch(`site:kindaling.de veranstaltungen frankfurt ${monthRange}`),
        serperSearch(`site:rheinmain4family.de Frankfurt Kinder ${monthRange}`),
        serperSearch(`site:frankfurt.de Kinder Veranstaltung ${monthRange}`),
        serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${curMonthDE} 2026`),
        serperSearch(`Kinderveranstaltungen "Frankfurt am Main" ${nextMonthDE} 2026`),
      ]).then(r => r.flat()),
      // kindaling: direct fetch, up to 15 000 chars (~50 events worth)
      fetchPageText('https://www.kindaling.de/veranstaltungen/frankfurt', 10000, 15000),
      // kinderfreizeit-frankfurt: small backup listing
      fetchPageText('https://kinderfreizeit-frankfurt.de/', 6000, 5000),
    ]);
    console.log(`[${elapsed()}] serper=${serperRaw.length} kindaling=${kindText?.length||0} kinderfreizeit=${kinderText?.length||0}`);

    // ── Step 2: Deduplicate Serper, then fetch top 10 pages (3000 chars each) ──
    const seenUrls = new Set(['https://www.kindaling.de/veranstaltungen/frankfurt', 'https://kinderfreizeit-frankfurt.de/']);
    const uniqueSerper = serperRaw
      .filter(r => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; })
      .sort((a, b) => (isDetailUrl(b.url)?1:0) - (isDetailUrl(a.url)?1:0));

    const serperPages = (await Promise.all(
      uniqueSerper.slice(0, 10).map(async r => {
        const text = await fetchPageText(r.url, 5000, 3000);
        return text ? { url: r.url, text } : { url: r.url, text: `${r.title}\n${r.snippet}` };
      })
    ));
    console.log(`[${elapsed()}] serper pages done`);

    // ── Build context ──
    const listingSection = [
      kindText  && `[LISTING: kindaling.de/veranstaltungen/frankfurt]\n${kindText}`,
      kinderText && `[LISTING: kinderfreizeit-frankfurt.de]\n${kinderText}`,
    ].filter(Boolean).join('\n\n---\n\n');

    const serperSection = serperPages.map((p, i) =>
      `[${i+1}] URL: ${p.url}\n${p.text}`
    ).join('\n\n---\n\n');

    const context = [listingSection, serperSection].filter(Boolean).join('\n\n===\n\n');
    console.log(`[${elapsed()}] context=${context.length} chars`);

    // ── Step 3: Claude ──
    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Include activities from ${tomorrowStr} to ${cutoffStr}.
Only skip if CLEARLY ended before ${tomorrowStr} — when unsure, include it.
Frankfurt am Main only. Skip Mainz, Wiesbaden, Darmstadt and other cities.

The [LISTING:] sections are live event listing pages — extract every distinct activity.

PAGE CONTENTS:
${context}

Output a JSON array. Start with [ end with ]. No limit on count — include every activity found.

Each object:
{"id":1,"emoji":"🦁","name":"Event name","nameZh":"中文名","description":"中文介绍","descriptionEn":"English.","location":"venue, address","dates":"Datum","datesEn":"Date in English","time":"HH:MM or HH:MM-HH:MM or siehe Website","price":"price or siehe Website","priceEn":"see website","booking":"domain.de","bookingUrl":"https://url","bookingType":"onsite","tags":["Tag"],"tagsZh":["标签"],"ageRange":"3+","ageGroup":"3-5"}

bookingType: "advance"|"onsite"|"free" (default "onsite")
ageGroup — set based on the MINIMUM age stated for the activity:
  "0-2"  = min age 0, 1, or 2 (Baby/Kleinkind activities)
  "3-5"  = min age 3, 4, or 5 (e.g. "ab 3 Jahren", "3+")
  "6-10" = min age 6, 7, 8, 9, or 10 (e.g. "ab 6 Jahren", "6+")
  "10+"  = min age 11 or older
  "all"  = NO minimum age stated AND explicitly for all ages/families (e.g. "für die ganze Familie", "alle Altersgruppen")
  If an activity says "3+" or "ab 3 Jahren", use "3-5" — NOT "all".
description: Chinese only. descriptionEn: English only.
time: "HH:MM" start only; "HH:MM-HH:MM" range; "siehe Website" unknown.
Do NOT stop at 10 or 15 — extract every activity you find.`;

    const raw = await callClaude(prompt);
    console.log(`[${elapsed()}] claude done`);

    const activities = parseActivities(raw);
    activities.forEach((a, i) => { a.id = i + 1; });
    console.log(`[${elapsed()}] parsed ${activities.length} activities`);

    if (activities.length === 0) {
      return res.status(500).json({ error: 'No activities parsed', raw: raw.slice(0, 500) });
    }

    await kvSet(cacheKey, JSON.stringify(activities));
    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error(`[${elapsed()}] fatal:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
