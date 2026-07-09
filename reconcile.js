// Shared reconciliation logic — this is the same math the frontend uses,
// ported here so the backend can run reconciliation entirely on its own,
// independent of anyone's browser being open. Keep this in sync with the
// frontend's copy if the rules ever change.

export const MARGIN_RATES = { Cash: 1.02, "Non-cash": 1.05 };

export const roundCents = (n) => Math.round(n * 100) / 100;

// NYSE/bond-market holiday calendar, used so T+1 settlement skips actual
// non-business days, not just weekends. Fixed table for the years this is
// likely to run in — a production system would pull this from a
// maintained exchange calendar instead.
export const MARKET_HOLIDAYS = new Set([
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export function addBusinessDays(dateStr, days) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !MARKET_HOLIDAYS.has(iso)) added++;
  }
  return d.toISOString().slice(0, 10);
}

// Computes the required collateral fresh off whatever price is currently
// known — a real daily mark-to-market, not a one-time snapshot. Falls back
// to the trade's last stored requirement if no live price is resolvable.
export function computeRequiredCollateral(t, prices) {
  const priceInfo = prices?.[t.security];
  if (!priceInfo) return t.strColl;
  const marginRate = MARGIN_RATES[t.collateralType] || 1.02;
  return roundCents(t.intQty * priceInfo.price * marginRate);
}

// The actual field-by-field comparison a nightly recon job performs,
// checked in materiality order: a settlement date problem blocks the
// trade before it even settles, so it's checked ahead of collateral
// sufficiency, which is only assessed once a position is live.
export function reconcileTrade(t, requiredCollateral) {
  const reasons = [];
  if (t.intSettleDate !== t.strSettleDate) {
    reasons.push("Settlement date mismatch");
  }
  if (t.intQty !== t.strQty) {
    reasons.push(
      t.strQty === 0 && t.intQty > 0 ? "Missing at agent"
        : t.intQty === 0 && t.strQty > 0 ? "Missing internal"
        : "Quantity mismatch"
    );
  }
  if (t.intRate !== t.strRate) {
    reasons.push(t.collateralType === "Non-cash" ? "Lending fee mismatch" : "Rebate rate mismatch");
  }
  const reqColl = requiredCollateral ?? t.strColl;
  if (t.intColl < reqColl) {
    reasons.push("Collateral shortfall");
  }
  if (reasons.length === 0) return { status: "Matched", breakTypes: [], requiredCollateral: reqColl };
  return { status: "Break", breakTypes: reasons, requiredCollateral: reqColl };
}

// Runs the same two-pass logic the frontend's manual "Run reconciliation"
// button does: pending trades get their first full check, and
// already-processed trades (Matched or Break) get their collateral
// re-checked against the latest price — bidirectionally, since a price
// move can newly break a clean position or newly clear a flagged one.
export function runReconciliationPass(trades, prices) {
  let matched = 0, broken = 0, marginCalls = 0, resolved = 0;
  const breakCounts = {};

  const updated = trades.map(t => {
    if (t.closed) return t;

    if (t.status === "Pending") {
      const requiredCollateral = computeRequiredCollateral(t, prices);
      const { status, breakTypes } = reconcileTrade(t, requiredCollateral);
      if (status === "Matched") {
        matched++;
        return { ...t, status, breakTypes: [], strColl: requiredCollateral, age: 0, assigned: "—", notes: [...t.notes, { author: "System", text: "Reconciliation run: all fields agree. Matched." }] };
      }
      broken++;
      breakTypes.forEach(r => { breakCounts[r] = (breakCounts[r] || 0) + 1; });
      return { ...t, status, breakTypes, strColl: requiredCollateral, age: 1, assigned: "Unassigned", notes: [...t.notes, { author: "System", text: `Reconciliation run: exception${breakTypes.length > 1 ? "s" : ""} raised — ${breakTypes.join("; ")}.` }] };
    }

    if (t.status === "Matched" || t.status === "Break") {
      const requiredCollateral = computeRequiredCollateral(t, prices);
      if (requiredCollateral === t.strColl) return t;
      const { status, breakTypes } = reconcileTrade(t, requiredCollateral);

      if (t.status === "Matched" && status === "Break") {
        marginCalls++;
        breakTypes.forEach(r => { breakCounts[r] = (breakCounts[r] || 0) + 1; });
        return { ...t, status, breakTypes, strColl: requiredCollateral, age: 1, assigned: "Unassigned",
          notes: [...t.notes, { author: "System", text: `Mark-to-market re-check: ${breakTypes.join("; ").toLowerCase()} — this position was fully collateralized at booking but no longer is at the current price.` }] };
      }
      if (t.status === "Break" && status === "Matched") {
        resolved++;
        return { ...t, status, breakTypes: [], strColl: requiredCollateral, age: 0, assigned: "—",
          notes: [...t.notes, { author: "System", text: "Mark-to-market re-check: the collateral requirement has moved back in line with what's posted. Matched." }] };
      }
      if (t.status === "Break") {
        const changed = JSON.stringify(breakTypes) !== JSON.stringify(t.breakTypes);
        return { ...t, breakTypes, strColl: requiredCollateral,
          notes: changed ? [...t.notes, { author: "System", text: `Reconciliation re-check: still broken — ${breakTypes.join("; ")}.` }] : t.notes };
      }
      return { ...t, strColl: requiredCollateral };
    }

    return t;
  });

  return { trades: updated, summary: { matched, broken, marginCalls, resolved, breakCounts, total: matched + broken } };
}
