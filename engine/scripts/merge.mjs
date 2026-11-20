// Pure helpers for merging scraped bank / credit-card transactions into data/budget.json.
// Kept free of I/O so they can be tested without network access.

import { readFileSync } from "node:fs";

// Shared with the app: public/rules.json
// public/rules.json in the app repo; rules.json next to this file in the shared engine
const RULES_PATHS = [process.env.RULES_FILE, new URL("../public/rules.json", import.meta.url), new URL("./rules.json", import.meta.url)].filter(Boolean);
export const RULES_CFG = (() => { for (const p of RULES_PATHS) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} } return { rules: [] }; })();

// Keep identical to categorize() in public/app.js
export function categorize(data, cfg, t) {
  const d = String(t.desc || ""), groups = data.groups || [];
  const has = (g) => groups.some((x) => x.id === g);
  const findItem = (g, re) => { if (!re) return undefined; const r = new RegExp(re, "i"); return (data.budget || []).find((b) => b.group === g && r.test(b.name))?.id; };
  const learned = data.settings?.rules || {};
  const key = Object.keys(learned).sort((a, b) => b.length - a.length).find((k) => d.includes(k));
  if (key) {
    const v = learned[key], g = typeof v === "string" ? v : v.group;
    if (g === "other" || has(g)) return { group: g, item: typeof v === "object" && (data.budget || []).some((b) => b.id === v.item) ? v.item : undefined };
  }
  for (const r of cfg?.rules || []) {
    if (r.sources && !r.sources.includes(String(t.source || "").split("-")[0])) continue;
    if (!new RegExp(r.match, "i").test(d)) continue;
    if (r.kind === "income") { if (Number(t.amount) < 0) return { kind: "income", group: "income" }; continue; }
    if (r.kind === "transfer") return { kind: "transfer", group: "transfer" };
    if (has(r.group)) return { group: r.group, item: findItem(r.group, r.item) };
  }
  if (t.foreign && cfg?.foreignFallback && has(cfg.foreignFallback)) return { group: cfg.foreignFallback };
  return { group: "other" };
}

const isoDay = (d) => {
  // scraper dates are ISO strings in UTC; convert to the Israeli calendar day
  const dt = new Date(d);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(dt);
};
const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const txKey = (t) => `${t.date}|${round2(t.amount)}|${String(t.desc).trim()}`;

/**
 * Convert scraper accounts → app transactions.
 * Expenses are stored as positive amounts (refunds/credits become negative).
 * Pending transactions (just swiped, not yet settled) are kept with `pending: true`;
 * every sync replaces the whole pending set, so once a purchase settles the pending copy disappears.
 */
export function toAppTxns(accounts, source) {
  const out = [];
  for (const acc of accounts || []) {
    for (const t of acc.txns || []) {
      const pending = !!t.status && t.status !== "completed";
      const charged = pending ? (t.chargedAmount || t.originalAmount) : (t.chargedAmount ?? t.originalAmount);
      if (!charged) continue;
      const inst = t.installments && t.installments.total > 1 ? ` (${t.installments.number}/${t.installments.total})` : "";
      out.push({
        date: isoDay(t.date),
        desc: `${String(t.description || "").trim()}${inst}`,
        amount: round2(-charged),
        source,
        account: acc.accountNumber ? String(acc.accountNumber).slice(-4) : undefined,
        bankId: pending ? undefined : t.identifier != null ? `${source}:${acc.accountNumber || ""}:${t.identifier}:${t.installments?.number || ""}` : undefined,
        ...(pending ? { pending: true } : {}),
        ...(t.originalCurrency && t.originalCurrency !== "ILS" && t.originalCurrency !== "₪" ? { foreign: `${t.originalAmount} ${t.originalCurrency}` } : {}),
      });
    }
  }
  return out;
}

/** Add new scraped transactions to data (mutates). Returns number added. */
export function mergeBankTxns(data, incoming, makeId) {
  data.transactions ??= [];
  // pending lines are a snapshot: drop the previous snapshot for these sources, then add the fresh one
  const sources = new Set(incoming.map((t) => t.source));
  const prevPending = new Set(data.transactions.filter((t) => t.pending && sources.has(t.source)).map(txKey));
  data.transactions = data.transactions.filter((t) => !(t.pending && sources.has(t.source)));
  incoming = [...incoming.filter((t) => !t.pending), ...incoming.filter((t) => t.pending)];
  const deleted = new Set(data.deletedBankIds || []);
  const byBankId = new Set(data.transactions.map((t) => t.bankId).filter(Boolean));
  const byKey = new Set(data.transactions.map(txKey));
  let added = 0;
  for (const t of incoming) {
    if (t.bankId && (byBankId.has(t.bankId) || deleted.has(t.bankId))) continue;
    if (byKey.has(txKey(t))) continue; // e.g. already imported manually from an Excel file
    if (!t.amount) continue; // zero-amount bookkeeping lines
    const c = categorize(data, RULES_CFG, t);
    const tx = { id: makeId(), ...t, group: c.group, item: c.item, kind: c.kind };
    Object.keys(tx).forEach((k) => tx[k] === undefined && delete tx[k]);
    data.transactions.push(tx);
    if (t.bankId) byBankId.add(t.bankId);
    byKey.add(txKey(t));
    if (!(t.pending && prevPending.has(txKey(t)))) added++; // a pending purchase we already showed isn't "new"
  }
  return added;
}
