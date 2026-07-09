# Matchbook backend (v2 — persistent)

This is the full rewrite: the backend now **stores your trade book** and
**runs reconciliation on its own schedule**, independent of whether your
browser tab is open. The old version only proxied price quotes; this one
is the actual source of truth.

## What changed from v1

- **New files**: `db.js` (MongoDB persistence), `reconcile.js` (the same
  reconciliation math the frontend uses, ported here), `prices.js` (price
  fetching, now server-side), `scheduler.js` (the catch-up scheduler).
- **New dependency**: MongoDB, via a free Atlas cluster.
- **New endpoints**: `GET/POST /api/trades`, `PUT/DELETE /api/trades/:id`,
  `POST /api/reconcile`, `GET/PUT /api/settings`.
- `/api/quote` still works exactly as before.

## An honest limitation, upfront

Render's free tier doesn't just idle between requests — it **suspends the
entire process**. Any in-memory timer (including this scheduler) stops
while the service is asleep. So "runs at exactly 4:30 PM even if nobody's
touched it in days" isn't actually achievable for free without one of:

- Upgrading to Render's paid tier (a few dollars/month, never sleeps), or
- Using a free external ping service (see step 5) to periodically wake it

What this **does** guarantee, on the free tier: every time the service is
awake for any reason (a frontend request, a keep-alive ping), it checks
"has today's batch run yet?" and catches up immediately if it's overdue.
That's the realistic, honest version of "nobody has to click a button" —
not perfectly on-the-dot timing, but never more than one wake-up cycle
behind.

## 1. Get a free MongoDB Atlas cluster

1. Go to **mongodb.com/cloud/atlas/register** — free, no credit card for
   the M0 tier (genuinely free forever, not a trial).
2. Create a free M0 cluster (any region).
3. Under **Database Access**, create a database user with a password.
4. Under **Network Access**, add `0.0.0.0/0` (allow from anywhere) — fine
   for this project; a production system would restrict this.
5. Click **Connect** → **Drivers** → copy the connection string. It looks
   like:
   ```
   mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/
   ```
   Replace `<password>` in it with your actual database user's password.

## 2. Run it locally

```bash
cd matchbook-backend-v2
npm install
cp .env.example .env
# paste your Finnhub key and Mongo connection string into .env
npm start
```

Test it:
```bash
curl "http://localhost:3001/api/trades"
```
Should return `{"trades":[]}` on a fresh database.

## 3. Redeploy on Render

Same Render service you already have, updated:
1. Push these new files to your `matchbook-backend` GitHub repo (replacing
   the old `server.js`, adding the new files).
2. In Render's dashboard, go to your service → **Environment** → add a new
   variable: `MONGODB_URI` = your connection string from step 1.
3. Render will auto-redeploy on the push. Check the logs for
   "Connected to MongoDB" to confirm it worked.

## 4. Test the new endpoints

```bash
curl -X POST https://your-service.onrender.com/api/trades \
  -H "Content-Type: application/json" \
  -d '{"security":"AAPL","counterparty":"Goldman Sachs","intQty":1000,"intRate":1.5,"intColl":300000,"collateralType":"Cash","tradeDate":"2026-07-09","intSettleDate":"2026-07-10"}'
```

Should return the created trade with a computed `strColl` (required
collateral) and `strSettleDate` (T+1).

```bash
curl https://your-service.onrender.com/api/trades
```

Should show that trade back.

## 5. (Recommended) Keep it awake with a free ping service

Go to **cron-job.org** (free, no card) and set up a job hitting
`https://your-service.onrender.com/health` every 10-15 minutes. This is
what makes the schedule check actually fire close to the scheduled time,
rather than only whenever the frontend happens to make a request.

## What's next

Once this is confirmed working, the frontend needs to be pointed at these
new endpoints instead of managing trades purely in local browser state.
That's a real rewiring job — come back and we'll do it once you've
confirmed the database connection works.
