import express from "express";
import cors from "cors";
import "dotenv/config";

import { getTrades, getTrade, insertTrade, updateTrade, deleteTrade, getSettings, updateSettings, replaceAllTrades } from "./db.js";
import { fetchQuote, fetchBenchmarkRate } from "./prices.js";
import { reconcileTrade, computeRequiredCollateral, addBusinessDays, MARGIN_RATES, roundCents, runReconciliationPass } from "./reconcile.js";
import { checkAndRunSchedule } from "./scheduler.js";

const app = express();
app.use(cors()); // for a real deployment, restrict this to your frontend's origin
app.use(express.json());

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) {
  console.warn("WARNING: FINNHUB_API_KEY is not set. Quote requests will fail until you set it.");
}

// Runs the catch-up schedule check on every request. Cheap (a settings
// read, and only actually does work if today's batch is overdue), and
// it's what makes "runs independently of anyone's tab being open" real —
// any traffic that wakes this service (including an external keep-alive
// ping) is a chance to notice a missed run and catch up immediately.
app.use(async (req, res, next) => {
  checkAndRunSchedule().catch(err => console.error("Schedule check failed:", err));
  next();
});
// Backup periodic check while the process happens to be alive with no
// incoming traffic at all — doesn't help if the whole service is asleep
// (Render's free tier suspends the process entirely), but covers the
// in-between case where it's awake but quiet.
setInterval(() => {
  checkAndRunSchedule().catch(err => console.error("Schedule check failed:", err));
}, 5 * 60 * 1000);

// --- Legacy quote proxy (kept for the frontend's on-demand ticker lookup) ---
const quoteCache = new Map();
const CACHE_MS = 15000;
app.get("/api/quote", async (req, res) => {
  const symbolsParam = req.query.symbols;
  if (!symbolsParam) {
    return res.status(400).json({ error: "Provide a symbols query param, e.g. /api/quote?symbols=AAPL,MSFT" });
  }
  const symbols = [...new Set(symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))];
  const quotes = {};
  await Promise.all(symbols.map(async (sym) => {
    const cached = quoteCache.get(sym);
    if (cached && cached.expires > Date.now()) { quotes[sym] = cached.data; return; }
    const q = await fetchQuote(sym);
    if (q) {
      const data = { price: q.price, prevClose: q.prevClose, asOf: new Date().toISOString() };
      quoteCache.set(sym, { data, expires: Date.now() + CACHE_MS });
      quotes[sym] = data;
    } else {
      quotes[sym] = { error: "no quote available" };
    }
  }));
  res.json({ quotes, asOf: new Date().toISOString() });
});

// --- Trades: the backend is now the source of truth ---

app.get("/api/trades", async (req, res) => {
  try {
    const trades = await getTrades();
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Capture a new trade. The client sends the booked internal terms; the
// server computes the street/agent side itself — same "locked, computed
// automatically" principle as the frontend, just enforced server-side now
// so the client genuinely can't fabricate the street side.
app.post("/api/trades", async (req, res) => {
  try {
    const b = req.body;
    if (!b.security || !b.counterparty || b.intQty == null || b.intRate == null || b.intColl == null || !b.tradeDate || !b.intSettleDate) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const security = String(b.security).trim().toUpperCase();
    const settings = await getSettings();
    let priceInfo = settings.prices?.[security];

    if (!priceInfo) {
      const q = await fetchQuote(security);
      if (q) {
        priceInfo = { price: q.price, prevClose: q.prevClose, source: "backend" };
        await updateSettings({ prices: { ...settings.prices, [security]: priceInfo } });
      } else if (b.manualPrice) {
        priceInfo = { price: Number(b.manualPrice), prevClose: Number(b.manualPrice), source: "manual" };
        await updateSettings({ prices: { ...settings.prices, [security]: priceInfo } });
      } else {
        return res.status(422).json({ error: "No live price available and no manualPrice provided for this security" });
      }
    }

    const intQty = Number(b.intQty);
    const intRate = Number(b.intRate);
    const intColl = Number(b.intColl);
    const collateralType = b.collateralType === "Non-cash" ? "Non-cash" : "Cash";
    const marginRate = MARGIN_RATES[collateralType] || 1.02;
    const marketValue = intQty * priceInfo.price;
    const requiredCollateral = roundCents(marketValue * marginRate);
    const requiredSettleDate = addBusinessDays(b.tradeDate, 1);

    const trade = {
      id: b.id?.trim() || `SL-${Math.floor(10000 + Math.random() * 89999)}`,
      counterparty: String(b.counterparty).trim(),
      security, cusip: "",
      intQty, strQty: intQty, originalQty: intQty,
      intRate, strRate: intRate,
      intColl, strColl: requiredCollateral,
      collateralType,
      borrowClass: b.borrowClass || "General Collateral",
      specialTier: b.borrowClass === "Special" ? (b.specialTier || "Warm") : null,
      tradeDate: b.tradeDate,
      intSettleDate: b.intSettleDate,
      strSettleDate: requiredSettleDate,
      status: "Pending", breakTypes: [], age: 0,
      assigned: "—",
      recalls: [], returns: [], dividendEvents: [], closed: false,
      notes: [{ author: "System", text: `Trade captured. Required settlement T+1 is ${requiredSettleDate}; required collateral is ${requiredCollateral.toFixed(2)} (${(marginRate * 100).toFixed(0)}% of ${marketValue.toFixed(2)} market value). Awaiting next reconciliation run.` }],
    };
    await insertTrade(trade);
    res.status(201).json({ trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// General-purpose update — assignment, notes, recall/return, resolving a
// break by hand. Accepts a partial object and merges it onto the trade.
app.put("/api/trades/:id", async (req, res) => {
  try {
    const trade = await updateTrade(req.params.id, req.body);
    if (!trade) return res.status(404).json({ error: "Trade not found" });
    res.json({ trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/trades/:id", async (req, res) => {
  try {
    await deleteTrade(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual "Run reconciliation now" — same pass the scheduler runs, just
// triggered on demand instead of waiting for the scheduled time.
app.post("/api/reconcile", async (req, res) => {
  try {
    const trades = await getTrades();
    const settings = await getSettings();
    const activeTickers = [...new Set(trades.filter(t => !t.closed).map(t => t.security))];
    const { refreshAllPrices } = await import("./prices.js");
    const prices = await refreshAllPrices(activeTickers, settings.prices || {});
    const benchmark = (await fetchBenchmarkRate()) || settings.benchmark;
    const { trades: updated, summary } = runReconciliationPass(trades, prices);
    await replaceAllTrades(updated);
    await updateSettings({ prices, benchmark, lastMtmRun: new Date().toISOString() });
    res.json({ summary, trades: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    res.json({ settings: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    res.json({ settings: await updateSettings(req.body) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Matchbook backend (v2, persistent) listening on port ${PORT}`));
