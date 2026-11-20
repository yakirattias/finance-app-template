import { test } from "node:test";
import assert from "node:assert/strict";
import { toAppTxns, mergeBankTxns, categorize, RULES_CFG } from "./merge.mjs";

const data = () => ({
  groups: [{ id: "home" }, { id: "car" }, { id: "fixed" }, { id: "fun" }, { id: "giving" }, { id: "travel" }],
  budget: [
    { id: "b12", group: "fixed", name: "תספורת" }, { id: "b11", group: "fixed", name: "מכבי שיניים" }, { id: "b9", group: "fixed", name: "מכבי" },
    { id: "b7", group: "car", name: "ביטוח רכב" }, { id: "b8", group: "car", name: "דלק" },
    { id: "b17", group: "fun", name: "מסעדות ומשלוחים" }, { id: "b18", group: "fun", name: "סופר ובית" }, { id: "b16", group: "fun", name: "בילויים, קניות, מסיבות" },
    { id: "b1", group: "home", name: "שכירות" },
  ],
  settings: { rules: { "זארה": "fun", "בעל הדירה": { group: "home", item: "b1" } } },
  transactions: [{ id: "x1", date: "2026-11-01", desc: "וולט", amount: 89.9, group: "fun" }],
});
const cat = (desc, extra = {}) => categorize(data(), RULES_CFG, { desc, amount: 10, ...extra });

const accounts = [{
  accountNumber: "1234",
  txns: [
    { identifier: 111, date: "2026-10-31T22:00:00.000Z", chargedAmount: -89.9, originalCurrency: "ILS", description: "וולט", status: "completed" },
    { identifier: 222, date: "2026-11-04T22:00:00.000Z", chargedAmount: -250, originalCurrency: "ILS", description: "פז רמת גן", status: "completed" },
    { identifier: 333, date: "2026-11-05T22:00:00.000Z", chargedAmount: -54.9, originalAmount: -14.99, originalCurrency: "USD", description: "NETFLIX.COM", status: "completed" },
    { identifier: 444, date: "2026-11-06T22:00:00.000Z", chargedAmount: -500, originalCurrency: "ILS", description: "KSP", status: "completed", installments: { number: 2, total: 6 } },
    { identifier: 555, date: "2026-11-07T22:00:00.000Z", chargedAmount: -40, description: "קפה", status: "pending" },
    { identifier: 666, date: "2026-11-08T22:00:00.000Z", chargedAmount: 120, description: "זיכוי זארה", status: "completed" },
    { identifier: 777, date: "2026-11-08T22:00:00.000Z", chargedAmount: 0, description: "העברת חיובים מחשבון לחשבון", status: "completed" },
  ],
}];

test("converts scraper output", () => {
  const t = toAppTxns(accounts, "visaCal");
  assert.equal(t[0].date, "2026-11-01");
  assert.equal(t[0].amount, 89.9);
  assert.match(t[3].desc, /\(2\/6\)$/);
  assert.equal(t[4].pending, true);
  assert.equal(t[5].amount, -120);
});

test("merges without duplicates, skips zero lines", () => {
  const d = data(); let n = 1;
  assert.equal(mergeBankTxns(d, toAppTxns(accounts, "visaCal"), () => `id${n++}`), 5, "4 settled + 1 pending");
  assert.equal(mergeBankTxns(d, toAppTxns(accounts, "visaCal"), () => `id${n++}`), 0, "pending snapshot refreshed, nothing new");
  assert.equal(d.transactions.filter((t) => t.pending).length, 1);
});

test("categorizes real merchants to groups and budget items", () => {
  assert.deepEqual(cat("UTOPIA BARBERSHOP"), { group: "fixed", item: "b12" });
  assert.deepEqual(cat("מכבידנט גבעתיים (11/12)"), { group: "fixed", item: "b11" });
  assert.deepEqual(cat("ליברה עסקאות ביטוח (3/10)"), { group: "car", item: "b7" });
  assert.deepEqual(cat("טעינה חשמלית - אדגר"), { group: "car", item: "b8" });
  assert.equal(cat("סופר וואש שטיפה אמריקאית").group, "car");
  assert.equal(cat("חניון גבעתיים").group, "car");
  assert.deepEqual(cat("WOLT"), { group: "fun", item: "b17" });
  assert.deepEqual(cat("חומוס חמודות"), { group: "fun", item: "b17" });
  assert.deepEqual(cat("אי אם פי אם הנשיא"), { group: "fun", item: "b18" });
  assert.deepEqual(cat("Temu.com"), { group: "fun", item: "b16" });
  assert.equal(cat("UNIQLO-C.FES_PHUKET", { foreign: "-4232 THB" }).group, "fun");
  assert.equal(cat("7-11 PHUKET AIRPORT.2", { foreign: "-30 THB" }).group, "travel");
  assert.equal(cat("SOME SHOP BANGKOK", { foreign: "-30 THB" }).group, "travel");
  assert.equal(cat("חנות כלשהי").group, "other");
  assert.deepEqual(cat("העברה לבעל הדירה"), { group: "home", item: "b1" }, "learned rule with item");
});

test("bank: salary is income, card bill is a transfer", () => {
  assert.equal(cat("משכורת אנזו", { source: "hapoalim", amount: -16254 }).kind, "income");
  assert.equal(cat("כרטיסי אשראי ויזה כאל", { source: "hapoalim", amount: 7400 }).kind, "transfer");
  assert.notEqual(cat("ויזה כאל", { source: "visaCal" }).kind, "transfer", "only bank lines are card bills");
});

test("pending purchases show up, then are replaced by the settled one", () => {
  const d = data(); let n = 1; const id = () => `id${n++}`;
  const acc = (txns) => [{ accountNumber: "1234", txns }];
  const swipe = { identifier: null, date: "2026-11-19T21:00:00.000Z", chargedAmount: 0, originalAmount: -64, originalCurrency: "ILS", description: "קפה גרג", status: "pending" };
  assert.equal(mergeBankTxns(d, toAppTxns(acc([swipe]), "visaCal"), id), 1);
  const p = d.transactions.find((t) => t.desc === "קפה גרג");
  assert.ok(p.pending); assert.equal(p.amount, 64); assert.equal(p.date, "2026-11-19");
  // same sync again: still exactly one
  mergeBankTxns(d, toAppTxns(acc([swipe]), "visaCal"), id);
  assert.equal(d.transactions.filter((t) => t.desc === "קפה גרג").length, 1);
  // next day it settles with an identifier
  const settled = { ...swipe, identifier: 999, chargedAmount: -64, status: "completed" };
  mergeBankTxns(d, toAppTxns(acc([settled]), "visaCal"), id);
  const rows = d.transactions.filter((t) => t.desc === "קפה גרג");
  assert.equal(rows.length, 1); assert.ok(!rows[0].pending); assert.ok(rows[0].bankId);
});

test("respects deleted transactions", () => {
  const d = data(); const t = toAppTxns(accounts, "visaCal");
  d.deletedBankIds = [t.find((x) => x.desc === "KSP (2/6)").bankId];
  mergeBankTxns(d, t, () => "id");
  assert.ok(!d.transactions.some((x) => x.desc.startsWith("KSP")));
});

import { readAccounts, pickAccounts } from "./accounts.mjs";
const SCR = { visaCal: { loginFields: ["username", "password"] }, max: { loginFields: ["username", "password"] }, isracard: { loginFields: ["id", "card6Digits", "password"] }, leumi: { loginFields: ["username", "password"] } };

test("accounts: JSON secret, several cards, validation, legacy env", () => {
  const env = { BANK_CREDENTIALS: JSON.stringify([
    { company: "visaCal", credentials: { username: "a", password: "b" } },
    { company: "visaCal", credentials: { username: "c", password: "d" }, label: "כאל של נועה" },
    { company: "isracard", credentials: { id: "1", password: "x" } },
    { company: "mastercard", credentials: { username: "u", password: "p" } },
  ]) };
  const { accounts, problems } = readAccounts(env, SCR);
  assert.deepEqual(accounts.map((a) => a.key), ["visaCal", "visaCal-2"]);
  assert.equal(accounts[1].name, "כאל של נועה");
  assert.match(problems.find((p) => p.key === "isracard").error, /card6Digits/);
  assert.match(problems.find((p) => p.key === "mastercard").error, /רשת סליקה/);
  assert.deepEqual(pickAccounts(accounts, "visaCal").length, 2);
  // legacy secrets still work when BANK_CREDENTIALS doesn't cover that company
  const legacy = readAccounts({ CAL_USERNAME: "a", CAL_PASSWORD: "b" }, SCR);
  assert.equal(legacy.accounts[0].company, "visaCal");
  assert.match(readAccounts({ BANK_CREDENTIALS: "{oops" }, SCR).problems[0].error, /JSON/);
});

test("bank rules apply to second accounts too (leumi-2)", () => {
  const d = data(); d.groups.push({ id: "fixed" });
  assert.equal(categorize(d, RULES_CFG, { desc: "משכורת", source: "leumi-2", amount: -9000 }).kind, "income");
});
