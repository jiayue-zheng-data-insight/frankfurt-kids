async function googleSearch(query) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.items?.[0]?.link || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = new Date();
    const twoMonths = new Date(today);
    twoMonths.setMonth(twoMonths.getMonth() + 2);
    const range = `${today.toISOString().split('T')[0]} to ${twoMonths.toISOString().split('T')[0]}`;

    const prompt = `List 6 children's activities in Frankfurt am Main for ${range}. Use real venues: Frankfurt Zoo, Senckenberg Museum, Städel Museum, Palmengarten, Römerberg, Kindermuseum Frankfurt.

Return ONLY this JSON array, no other text:
[{"id":1,"emoji":"🦁","name":"Event name","nameZh":"活动中文名","description":"一两句中文介绍。","descriptionEn":"One or two sentences in English.","location":"Real Frankfurt address","dates":"Datum DE","datesEn":"Date EN","time":"10:00-17:00","price":"Erw. €12 / Kinder €6","priceEn":"Adults €12 / Children €6","booking":"zoo-frankfurt.de","bookingUrl":"https://www.zoo-frankfurt.de","needsBooking":false,"tags":["Animals","Outdoor"],"tagsZh":["动物","户外"],"ageRange":"3+"}]`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
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

    // Search for real URLs in parallel
    const urls = await Promise.all(
      activities.map(a => googleSearch(`${a.name} Frankfurt`))
    );
    urls.forEach((url, i) => {
      if (url) activities[i].bookingUrl = url;
    });

    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
}
