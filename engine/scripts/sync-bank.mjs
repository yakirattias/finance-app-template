// Pulls recent transactions from Israeli credit-card / bank sites and merges them into data/budget.json.
// Runs in GitHub Actions — in your own repo, or as the shared engine called from each user's data repo.
// Credentials come only from that repo's secrets (see accounts.mjs).
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createScraper, SCRAPERS } from "israeli-bank-scrapers";
import { toAppTxns, mergeBankTxns } from "./merge.mjs";
import { readAccounts, pickAccounts } from "./accounts.mjs";

const DATA = process.env.DATA_FILE || new URL("../data/budget.json", import.meta.url);
const SCRAPED = process.env.SCRAPED_FILE || "/tmp/scraped.json";
const APPLY_ONLY = process.argv.includes("--apply-only");
const DAYS_BACK = Number(process.env.SYNC_DAYS_BACK || 60);
const SCHEDULED = process.env.GITHUB_EVENT_NAME === "schedule";

const { accounts, problems } = readAccounts(process.env, SCRAPERS || {});
const ACTIVE = pickAccounts(accounts, process.env.SYNC_PROVIDERS || "all");

const israelNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

async function main() {
  const data = JSON.parse(await readFile(DATA, "utf8"));
  data.bankSync ??= {};
  const now = israelNow();

  // The schedule fires at both 06:00 and 07:00 UTC so that one of them is 09:00 in Israel
  // in summer and in winter. Skip the early one and any repeat on the same day.
  if (!APPLY_ONLY && SCHEDULED && (now.hour < 9 || data.bankSync.lastScheduledDay === now.day)) {
    console.log(`Skipping scheduled run (Israel ${now.day} ${now.hour}:00).`);
    return;
  }
  if (!APPLY_ONLY && !ACTIVE.length && !problems.length) throw new Error("No accounts configured. Add the BANK_CREDENTIALS secret (the app's 'חיבור כרטיסים ובנקים' screen builds it).");

  let scraped;
  if (APPLY_ONLY) {
    scraped = JSON.parse(await readFile(SCRAPED, "utf8"));
  } else {
    const startDate = new Date(Date.now() - DAYS_BACK * 86400000);
    // configuration problems are reported per account, so the app can say exactly what to fix
    scraped = problems.map((p) => ({ provider: p.key, name: p.name, ok: false, error: p.error }));
    for (const p of ACTIVE) {
      console.log(`Scraping ${p.key} since ${startDate.toISOString().slice(0, 10)}…`);
      const scraper = createScraper({
        companyId: p.company,
        startDate,
        combineInstallments: false,
        showBrowser: false,
        timeout: 120000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      try {
        const res = await scraper.scrape(p.credentials);
        if (!res.success) {
          console.error(`${p.key} failed: ${res.errorType} ${res.errorMessage || ""}`);
          // keep the scraper's message (no credentials in it) so the app can show why it failed
          const msg = String(res.errorMessage || "").replace(/\s+/g, " ").slice(0, 300);
          scraped.push({ provider: p.key, name: p.name, ok: false, error: [res.errorType || "UNKNOWN", msg].filter(Boolean).join(": ") });
        } else {
          scraped.push({ provider: p.key, name: p.name, ok: true, txns: toAppTxns(res.accounts, p.key) });
        }
      } catch (e) {
        console.error(`${p.key} crashed: ${e.message}`);
        scraped.push({ provider: p.key, name: p.name, ok: false, error: e.message.slice(0, 200) });
      }
    }
    // kept so the merge can be re-applied on top of a newer data file if the push races an app edit
    await writeFile(SCRAPED, JSON.stringify(scraped));
  }

  const results = scraped.map((r) => {
    if (!r.ok) return { provider: r.provider, name: r.name, ok: false, error: r.error };
    const added = mergeBankTxns(data, r.txns, () => randomBytes(5).toString("hex"));
    console.log(`${r.provider}: ${r.txns.length} transactions scraped, ${added} new.`);
    return { provider: r.provider, name: r.name, ok: true, scraped: r.txns.length, added };
  });

  // keep the latest result per source, so syncing only the bank doesn't hide Cal's status
  const ranAt = new Date().toISOString();
  const prev = (data.bankSync.lastResults || []).filter((r) => !results.some((x) => x.provider === r.provider));
  data.bankSync = {
    ...data.bankSync,
    lastRun: ranAt,
    lastResults: [...prev, ...results.map((r) => ({ ...r, at: ranAt, trigger: SCHEDULED ? "schedule" : "manual" }))],
    ...(SCHEDULED ? { lastScheduledDay: now.day } : {}),
  };
  data.updatedAt = new Date().toISOString();
  await writeFile(DATA, JSON.stringify(data, null, 2) + "\n");

  const added = results.reduce((a, r) => a + (r.added || 0), 0);
  console.log(`Done. ${added} new transactions.`);
  if (results.length && results.every((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
