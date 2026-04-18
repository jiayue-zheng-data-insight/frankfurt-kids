export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const today = new Date();
    const oneMonthLater = new Date(today);
    oneMonthLater.setMonth(oneMonthLater.getMonth() + 2);
    const dateRange = `${today.toISOString().split('T')[0]} to ${oneMonthLater.toISOString().split('T')[0]}`;

    const prompt = `Generate a list of 8 realistic children's activities and family events in Frankfurt am Main, Germany for the date range: ${dateRange}.

These should be based on real, recurring or typical events that happen in Frankfurt — things like zoo visits, museum workshops, theatre shows, outdoor festivals, cinema events, etc.

Return ONLY a JSON array with this structure:
[
  {
    "id": 1,
    "emoji": "🎪",
    "name": "Activity name in German or English",
    "nameZh": "Activity name in Chinese",
    "description": "2-3 sentences about this activity in Chinese",
    "descriptionEn": "2-3 sentences in English",
    "location": "Real Frankfurt address",
    "dates": "Date range in German format",
    "datesEn": "Date range in English",
    "time": "Opening hours",
    "price": "Ticket prices in German (Erwachsene/Kinder)",
    "priceEn": "Ticket prices in English",
    "booking": "website domain only e.g. zoo-frankfurt.de",
    "bookingUrl": "https://full-url",
    "needsBooking": true or false,
    "tags": ["tag1", "tag2"],
    "tagsZh": ["标签1", "标签2"],
    "ageRange": "e.g. 3+"
  }
]

Use real Frankfurt venues: Frankfurt Zoo, Senckenberg Museum, Städel Museum, Palmengarten, Römerberg, Mal seh'n Kino, Frankfurter Kunstverein, Kindermuseum Frankfurt, Theater am Turm, etc.
Return ONLY the JSON array, no other text.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 2048,
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
    return res.status(200).json({ success: true, activities });

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: err.message });
  }
}
