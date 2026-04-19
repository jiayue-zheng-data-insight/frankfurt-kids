# Frankfurt Kids Activity App — Project Background

## What This Is
A bilingual (Chinese/English) PWA web app for a Chinese family living in Frankfurt, Germany.
The app helps parents discover children's activities, scan event posters, and schedule them into family weekends.

## Current Status
- **Live URL**: https://frankfurt-kids.vercel.app
- **GitHub**: https://github.com/jiayue-zheng-data-insight/frankfurt-kids
- **Stack**: Vanilla HTML/CSS/JS frontend + Vercel Serverless Functions (Node.js)
- **Deployed**: Vercel (auto-deploys on git push to main)

## File Structure
```
frankfurt-kids/
├── index.html          # Entire frontend (single file, vanilla JS)
├── api/
│   ├── scan.js         # POST /api/scan — Claude Vision scans poster image
│   └── search.js       # POST /api/search — Claude Haiku generates activity list
├── vercel.json         # Vercel config (timeouts: scan 30s, search 60s)
└── CLAUDE.md           # This file
```

## Environment Variables (set in Vercel dashboard)
- `ANTHROPIC_API_KEY` — Anthropic API key (used by both api/scan.js and api/search.js)

## Features Built & Working
1. **📷 Scan page** — Upload poster image → Claude Vision extracts: name, location, dates, times, price, booking info, needsBooking flag
2. **🔍 Discover page** — Calls /api/search → Claude Haiku generates 6 Frankfurt children's activities with real venues
3. **📋 Plan page** — Select activities → auto-schedule onto upcoming weekends (Sat/Sun/both preference)
4. **📅 Calendar page** — Monthly view, blue dots = events, red dots = needs pre-booking
5. **Language toggle** — Full Chinese/English switch (top right)
6. **Apple Calendar export** — Downloads .ics file with all scheduled events
7. **Google Calendar** — Opens google calendar URL for each event (one tab per event)
8. **Accordion detail cards** — Tap activity to expand inline: description, location, time, price, website link

## Known Issues / Next Steps
1. **Activity links go to homepage only** — /api/search returns homepage URLs (e.g. zoo-frankfurt.de), not specific event pages. Fix: integrate Google Custom Search API to find specific event URLs
2. **Scan page field labels show as FL-NAME, FL-LOC etc** — translation keys not resolving in scan result HTML. Fix: replace with hardcoded labels or fix t() call in showScanResult()
3. **Google Calendar OAuth** — currently opens a new tab per event; real sync needs Google OAuth flow
4. **Activity count** — currently 6 activities; can increase but watch for 60s timeout on Vercel free tier

## API Details

### POST /api/scan
Request: `{ imageBase64: string, mimeType: string }`
Response: `{ success: true, activity: { name, location, dates, times, price, booking, needsBooking, description, descriptionEn, tags, ageRange } }`
Model: `claude-opus-4-5`

### POST /api/search
Request: `{}` (no body needed)
Response: `{ success: true, activities: [...] }`
Model: `claude-haiku-4-5-20251001`
Each activity: `{ id, emoji, name, nameZh, description, descriptionEn, location, dates, datesEn, time, price, priceEn, booking, bookingUrl, needsBooking, tags, tagsZh, ageRange }`

## Deploy Workflow
```bash
# Make changes locally, then:
git add .
git commit -m "description"
git push
# Vercel auto-deploys in ~1 minute
```

## Design Decisions
- Single `index.html` file (no build step, no framework) — keeps it simple for non-developer owner
- Vercel serverless functions as backend — free tier, no server management
- Claude Haiku for search (fast + cheap), Claude Opus for scan (better vision accuracy)
- Activities stored in JS array in memory — no database needed for MVP
- .ics export for Apple Calendar (no OAuth needed), Google Calendar via URL (no OAuth needed for basic use)

## User Profile
- Chinese family living in Frankfurt, Germany
- Primary language: Chinese, secondary: English (German activities need Chinese translation)
- Uses both iPhone (Apple Calendar) and potentially Google Calendar
- Non-technical user — all updates should be deployable via simple git push
