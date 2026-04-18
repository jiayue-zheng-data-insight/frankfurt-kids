export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const prompt = `You are analyzing a children's activity or event poster. Extract all information you can see and return ONLY a JSON object with these fields (use null if not found):

{
  "name": "activity/event name",
  "nameEn": "English translation if name is in German",
  "location": "full address or location description",
  "dates": "all dates mentioned",
  "times": "opening times or show times",
  "price": "ticket prices for adults and children",
  "booking": "how to book / website / phone",
  "needsBooking": true or false (true if advance booking is recommended),
  "description": "2-3 sentence description of what this activity is, in Chinese",
  "descriptionEn": "2-3 sentence description in English",
  "tags": ["tag1", "tag2"] (e.g. Circus, Museum, Outdoor, Art, etc),
  "ageRange": "recommended age range"
}

Return ONLY the JSON, no other text.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType || 'image/jpeg',
                data: imageBase64
              }
            },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: 'Claude API error', detail: err });
    }

    const data = await response.json();
    const text = data.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json({ success: true, activity: parsed });

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: err.message });
  }
}
