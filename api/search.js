async function serperSearch(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, gl: 'de', hl: 'de', num: 10 })
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[Serper] FAILED status=${res.status} body=${body.slice(0, 300)}`);
    return [];
  }
  const data = JSON.parse(body);
  const organic = data.organic || [];
  console.log(`[Serper] query="${query}" → ${organic.length} results`);
  organic.forEach(r => console.log(`  • ${r.link}`));
  return organic.map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
}

// Extract event detail links from HTML (relative → absolute)
function extractEventLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const hrefs = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], base).href;
      // Keep only same-domain links that look like specific event/detail pages
      if (abs.startsWith(base.origin) && abs !== baseUrl) {
        const path = new URL(abs).pathname;
        if (path.length > 1 && /event|veranstaltung|show|detail|programm|kurs|workshop|ausstellung/i.test(path)) {
          hrefs.push(abs);
        }
      }
    } catch {}
  }
  // Deduplicate
  return [...new Set(hrefs)].slice(0, 15);
}

// Fetch a page; return { text, eventLinks }
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FrankfurtKidsBot/1.0)' }
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[Fetch] ${url} → ${res.status}`); return null; }
    const html = await res.text();
    const eventLinks = extractEventLinks(html, url);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
    console.log(`[Fetch] ${url} → ${text.length} chars, ${eventLinks.length} event links`);
    eventLinks.forEach(l => console.log(`  ↳ ${l}`));
    return { text, eventLinks };
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
      max_tokens: 3000,
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

    const curMonthDE  = today.toLocaleString('de-DE', { month: 'long' });
    const curMonthEN  = today.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const nextMonthObj = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const nextMonthDE = nextMonthObj.toLocaleString('de-DE', { month: 'long' });
    const nextMonthEN = nextMonthObj.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    const dateRange   = `${curMonthEN} and ${nextMonthEN}`;

    // Step 1: Serper search — two queries in parallel
    const rawResults = await Promise.all([
      serperSearch(`Kinderveranstaltungen Frankfurt ${curMonthDE} 2026`),
      serperSearch(`Kinderveranstaltungen Frankfurt ${nextMonthDE} 2026`)
    ]).then(r => r.flat());

    const seen = new Set();
    const uniqueResults = rawResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    console.log(`[Search] ${uniqueResults.length} unique URLs from Serper`);
    if (uniqueResults.length === 0) {
      return res.status(502).json({ error: 'Serper returned no results. Check SERPER_API_KEY in Vercel.' });
    }

    // Step 2: Fetch actual page content in parallel (top 8, 6s timeout each)
    const pages = await Promise.all(
      uniqueResults.slice(0, 8).map(async r => {
        const result = await fetchPage(r.url);
        return { url: r.url, title: r.title, ...(result || { text: null, eventLinks: [] }) };
      })
    );
    const fetchedPages = pages.filter(p => p.text);
    console.log(`[Search] ${fetchedPages.length}/${pages.length} pages fetched successfully`);

    // Collect all discovered event detail links across all fetched pages
    const allEventLinks = [...new Set(fetchedPages.flatMap(p => p.eventLinks || []))];
    console.log(`[Search] ${allEventLinks.length} total event detail links found`);

    // Build context: page text + discovered event-specific links
    const context = fetchedPages.length > 0
      ? fetchedPages.map((p, i) => {
          const links = (p.eventLinks || []).length > 0
            ? `\nEvent detail links found on this page:\n${p.eventLinks.map(l => `  - ${l}`).join('\n')}`
            : '';
          return `[${i + 1}] PAGE URL: ${p.url}${links}\n\nPAGE TEXT:\n${p.text}`;
        }).join('\n\n---\n\n')
      : uniqueResults.map((r, i) => `[${i + 1}] URL: ${r.url}\nTitle: ${r.title}\n${r.snippet}`).join('\n\n');

    const prompt = `You are helping a Chinese family in Frankfurt find children's activities for ${dateRange}.

Today is ${tomorrowStr}. Only include activities happening between ${tomorrowStr} and ${cutoffStr} (next 30 days). Skip anything outside that window.

Below is the actual text content scraped from real event web pages. Extract up to 6 distinct children's activities, reading dates, location, price, and booking info directly from the page text.

PAGE CONTENTS:
${context}

Output a JSON array of up to 6 objects. Start with [ end with ]. Raw JSON only.

Each object must have exactly these fields:
{"id":1,"emoji":"🦁","name":"Event name from page","nameZh":"活动中文名（翻译成中文）","description":"用中文写一两句介绍这个活动。","descriptionEn":"One or two sentences in English.","location":"Exact venue name and address from page","dates":"Datum from page","datesEn":"Date in English","time":"HH:MM-HH:MM or see website","price":"exact price from page or siehe Website","priceEn":"exact price in English or see website","booking":"domain.de","bookingUrl":"https://exact-page-url","bookingType":"advance","tags":["Tag1"],"tagsZh":["标签1"],"ageRange":"3+"}

Rules:
- Read location, dates, price directly from the page text — do not guess
- bookingUrl: use a specific event detail link from "Event detail links found on this page" when available — these are deeper links to the actual event page. Only fall back to the PAGE URL if no detail link matches the activity
- description MUST be in Chinese; descriptionEn MUST be in English; never leave German in these fields
- nameZh must be a Chinese translation of the event name
- tags in English, tagsZh same tags in Chinese
- bookingType:
    "advance" — page mentions: Anmeldung erforderlich, online buchen, Tickets kaufen, im Voraus
    "onsite"  — page mentions: Tageskasse, Eintritt, Eintrittskarte, tickets at door
    "free"    — page mentions: freier Eintritt, kostenlos, ohne Anmeldung, Eintritt frei
    default to "onsite" when unclear
- Skip activities outside ${tomorrowStr}–${cutoffStr}`;

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
