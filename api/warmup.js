// Daily cache warmup — called by Vercel Cron at 05:00 UTC (07:00 Frankfurt)
// Populates KV cache before users wake up so first visit is instant
export default async function handler(req, res) {
  // Only allow GET (from cron) or POST with a secret to prevent abuse
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }

  try {
    const base = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://frankfurt-kids.vercel.app';

    // Call search with force=false: uses cache if already warm, fetches if cold
    const r = await fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: false })
    });

    const data = await r.json();
    const count = data.activities?.length ?? 0;
    const source = data.cached ? 'cache' : 'fresh';
    console.log(`[Warmup] ${source}: ${count} activities`);

    return res.status(200).json({ ok: true, source, count });
  } catch (err) {
    console.error('[Warmup] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
