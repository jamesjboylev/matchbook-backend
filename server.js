import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors()); // for a real deployment, restrict this to your frontend's origin

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) {
  console.warn("WARNING: FINNHUB_API_KEY is not set. Quote requests will fail until you set it.");
}

// Simple in-memory cache so a burst of page loads doesn't blow through
// Finnhub's free-tier rate limit (60 calls/minute).
const cache = new Map(); // symbol -> { data, expires }
const CACHE_MS = 15000;

app.get("/api/quote", async (req, res) => {
  const symbolsParam = req.query.symbols;
  if (!symbolsParam) {
    return res.status(400).json({ error: "Provide a symbols query param, e.g. /api/quote?symbols=AAPL,MSFT" });
  }
  const symbols = [...new Set(symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];

  const quotes = {};
  await Promise.all(symbols.map(async (sym) => {
    const cached = cache.get(sym);
    if (cached && cached.expires > Date.now()) {
      quotes[sym] = cached.data;
      return;
    }
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Finnhub responded ${r.status}`);
      const q = await r.json();
      // Finnhub returns all zeros for an invalid/unsupported symbol
      if (typeof q.c !== "number" || (q.c === 0 && q.pc === 0)) throw new Error("no quote available for this symbol");
      const data = {
        price: q.c,
        prevClose: q.pc,
        high: q.h,
        low: q.l,
        asOf: new Date().toISOString(),
      };
      cache.set(sym, { data, expires: Date.now() + CACHE_MS });
      quotes[sym] = data;
    } catch (err) {
      quotes[sym] = { error: err.message };
    }
  }));

  res.json({ quotes, asOf: new Date().toISOString() });
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Matchbook price backend listening on port ${PORT}`));
