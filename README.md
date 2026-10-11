# GCC Atlas

Evidence sheets for India's GCC market, with a small backend that keeps the data fresh.

```
public/index.html    the frontend (one file, no build step)
public/data.json     static fallback data
server.js            the backend (Node 18+, no dependencies)
data/base.json       curated baseline, every figure sourced
data/live.json       created by the collector at runtime
```

## How the data stays current

1. `data/base.json` is the curated baseline.
2. The collector asks Gemini, with Google Search grounding, for three things: published GCC counts, new GCC announcements from the last 90 days, and the latest broker rent and vacancy figures for six cities.
3. Every item must pass checks before it is kept: a number inside a sane range, an `https` source URL, a real date that is recent enough. Anything else is dropped.
4. Kept items are written to `data/live.json` and shown in the UI with an **AI** badge and a link to their source. The curated baseline is never overwritten.
5. It runs on start, then daily. `POST /api/refresh` runs it on demand.

The AI collector can still be wrong. That is why every collected figure carries its source link and an AI badge.

## Run it locally

```
GEMINI_API_KEY=your-key ADMIN_TOKEN=any-long-string node server.js
```

Open http://localhost:3000. Without a key the site still works from the curated data. To try the pipeline with no key at all: `npm run dev:mock`.

## Deploy (Render, free tier)

1. Push this folder to a GitHub repo. `.gitignore` already excludes `.env` and `data/live.json`.
2. On render.com, create a **Web Service** from the repo. Build command: leave empty. Start command: `node server.js`.
3. Add environment variables in Render's dashboard (not in the code): `GEMINI_API_KEY` and `ADMIN_TOKEN`.
4. Deploy. The first collection runs about 3 seconds after start.

Check it: `https://YOUR-APP.onrender.com/api/status`

Refresh on demand:
```
curl -X POST -H "x-admin-token: YOUR_ADMIN_TOKEN" https://YOUR-APP.onrender.com/api/refresh
```

Free-tier hosts sleep when idle and may lose `data/live.json` on restart. The collector refills it on the next start, so this is safe.

## Security notes

- The API key is read from the environment only. It never reaches the browser, a log or a file.
- Anything pasted into a chat or committed to a repo should be treated as exposed. Create a new key and delete the old one when the project is done.
- Restrict the key in Google Cloud to the Generative Language API.
- Text collected by AI is escaped before display and links must start with `https://`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/data` | Current dataset |
| GET | `/api/status` | Collector state, no secrets |
| POST | `/api/refresh` | Needs `x-admin-token`. Limited to once per 10 minutes |
| GET | `/api/health` | Liveness check |

## Not verified here

The collector was tested end to end in mock mode. The live Gemini call could not be tested from the build environment, so check `/api/status` after your first deploy. If it reports an error, the message names the cause. The model name is set by `GEMINI_MODEL` if you need a different one.
