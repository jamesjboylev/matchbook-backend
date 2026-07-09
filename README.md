# Matchbook price backend

A tiny Express server that fetches real equity quotes server-side (hiding
your API key and avoiding the browser CORS problem) and serves them to the
Matchbook frontend at `/api/quote?symbols=AAPL,MSFT`.

## Why you need this at all

The frontend alone can't get real prices reliably:
- Most market data providers don't allow direct browser calls (no CORS
  headers), so a `fetch()` straight from the page gets blocked.
- Any API key you put in frontend JavaScript is visible to anyone who views
  source — public-facing keys get abused and revoked fast.
- A server can cache quotes for a few seconds so a burst of page loads
  doesn't blow through a free-tier rate limit.

This backend solves all three: it holds the key, it's the one actually
calling the data provider, and your frontend just calls *your* server.

## 1. Get a free API key

This uses [Finnhub](https://finnhub.io/register) — free tier, no credit
card, instant signup, real-time-ish US equity quotes. (Bonds/Treasuries
generally require a specialized fixed-income data vendor and aren't
covered by this free tier — that's why those two lines in Matchbook stay
labeled "Simulated" even with this backend running.)

Sign up, copy your API key from the dashboard.

## 2. Run it locally

```bash
cd matchbook-backend
npm install
cp .env.example .env
# paste your key into .env
npm start
```

Test it:
```bash
curl "http://localhost:3001/api/quote?symbols=AAPL,MSFT"
```

You should get back something like:
```json
{
  "quotes": {
    "AAPL": { "price": 305.12, "prevClose": 303.80, "high": 307.40, "low": 302.10, "asOf": "..." },
    "MSFT": { "price": 388.44, "prevClose": 386.90, "high": 390.10, "low": 385.00, "asOf": "..." }
  },
  "asOf": "..."
}
```

## 3. Point the Matchbook frontend at it

In `matchbook-recon-platform.html` (or the `.jsx` version), find the
**Backend URL** field in the price tracker panel and paste in
`http://localhost:3001` while testing locally, or your deployed URL (step 4)
once it's live. The app will automatically switch from simulated prices to
this backend's real quotes.

## 4. Deploy it for free (so it's not just running on your laptop)

**Render.com** is the easiest free option:
1. Push this folder to a GitHub repo (just this `matchbook-backend` folder, or the whole project).
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo.
3. Root directory: `matchbook-backend` (if it's part of a bigger repo).
4. Build command: `npm install` — Start command: `npm start`.
5. Add an environment variable: `FINNHUB_API_KEY` = your key.
6. Deploy. Render gives you a URL like `https://matchbook-backend.onrender.com`.

Paste that URL into the Backend URL field in the app and you're running on
real quotes, hosted for free.

(Free tier note: Render's free web services spin down after inactivity and
take ~30–60 seconds to wake back up on the next request — fine for a demo,
just don't expect instant response on the very first refresh after it's
been idle.)

## Security note if you go beyond a demo

- Restrict `cors()` in `server.js` to your actual frontend's origin instead
  of allowing all origins.
- Never commit your `.env` file — it's already covered by a typical
  `.gitignore`, but double check before pushing.
