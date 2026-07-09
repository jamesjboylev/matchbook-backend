const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// Fetches a quote for one ticker via Finnhub. Falls back to null on any
// failure — the caller decides what to do (keep the last known price,
// simulate a tick, etc.), same graceful-degradation pattern as the
// frontend's own price tracker.
export async function fetchQuote(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const q = await res.json();
    if (typeof q.c !== "number" || (q.c === 0 && q.pc === 0)) return null;
    return { price: q.c, prevClose: q.pc };
  } catch {
    return null;
  }
}

// The Tri-Party General Collateral Rate (TGCR) — the market's own name for
// the general collateral repo rate, and the most fitting free, public
// anchor for a cash rebate rate. Falls back to null on failure.
export async function fetchBenchmarkRate() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://markets.newyorkfed.org/api/rates/secured/all/latest.json", { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const rates = data?.refRates || [];
    const tgcr = rates.find(r => r.type === "TGCR")?.percentRate;
    const sofr = rates.find(r => r.type === "SOFR")?.percentRate;
    const asOf = rates.find(r => r.type === "TGCR")?.effectiveDate || rates[0]?.effectiveDate;
    if (typeof tgcr !== "number" && typeof sofr !== "number") return null;
    return { tgcr: tgcr ?? sofr, sofr: sofr ?? tgcr, asOf, source: "live" };
  } catch {
    return null;
  }
}

// Refreshes prices for whatever tickers are actually on the book, used by
// the scheduler before each reconciliation pass. Keeps the last known
// price (rather than a fixed seed) if a given ticker's fetch fails, so a
// single bad fetch doesn't reset an otherwise-tracked security.
export async function refreshAllPrices(tickers, currentPrices) {
  const next = { ...currentPrices };
  await Promise.all(tickers.map(async (tkr) => {
    const q = await fetchQuote(tkr);
    if (q) {
      next[tkr] = { price: q.price, prevClose: q.prevClose, source: "backend" };
    }
    // On failure, leave whatever was already tracked for this ticker alone.
  }));
  return next;
}
