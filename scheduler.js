import { getSettings, updateSettings, getTrades, replaceAllTrades } from "./db.js";
import { refreshAllPrices, fetchBenchmarkRate } from "./prices.js";
import { runReconciliationPass } from "./reconcile.js";

let running = false; // simple in-process lock so overlapping checks can't double-run

export async function checkAndRunSchedule() {
  if (running) return null;
  const settings = await getSettings();
  if (!settings.autoScheduleEnabled) return null;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (settings.lastAutoRunDate === todayStr) return null; // already run today

  const [h, m] = (settings.mtmScheduleTime || "16:30").split(":").map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(h, m, 0, 0);
  if (now < scheduled) return null; // not due yet

  running = true;
  try {
    const trades = await getTrades();
    const activeTickers = [...new Set(trades.filter(t => !t.closed).map(t => t.security))];

    const prices = await refreshAllPrices(activeTickers, settings.prices || {});
    const benchmark = (await fetchBenchmarkRate()) || settings.benchmark;

    const { trades: updatedTrades, summary } = runReconciliationPass(trades, prices);
    await replaceAllTrades(updatedTrades);
    await updateSettings({
      prices,
      benchmark,
      lastMtmRun: now.toISOString(),
      lastAutoRunDate: todayStr,
    });

    console.log(`Scheduled batch complete: ${JSON.stringify(summary)}`);
    return summary;
  } finally {
    running = false;
  }
}
