// Which bank / card accounts to sync, read from repository secrets. Pure (no I/O) so it can be tested.
//
// Preferred: one secret, BANK_CREDENTIALS, holding a JSON array — the app's "חיבור כרטיסים ובנקים" screen builds it:
//   [{ "company": "visaCal", "credentials": { "username": "...", "password": "..." } },
//    { "company": "max",     "credentials": { "username": "...", "password": "..." }, "label": "מקס של נועה" }]
// Older setups with CAL_USERNAME / CAL_PASSWORD (etc.) keep working.

export const COMPANY_NAMES = {
  visaCal: "כאל", max: "מקס", isracard: "ישראכרט", amex: "אמריקן אקספרס",
  hapoalim: "בנק הפועלים", leumi: "בנק לאומי", discount: "בנק דיסקונט", mercantile: "בנק מרכנתיל",
  mizrahi: "מזרחי טפחות", beinleumi: "הבינלאומי", otsarHahayal: "אוצר החייל", massad: "בנק מסד",
  yahav: "בנק יהב", union: "בנק איגוד", pagi: "בנק פאג״י", beyahadBishvilha: "ביחד בשבילך", behatsdaa: "בהצדעה",
};
export const BANKS = new Set(["hapoalim", "leumi", "discount", "mercantile", "mizrahi", "beinleumi", "otsarHahayal", "massad", "yahav", "union", "pagi"]);

const LEGACY = [
  ["visaCal", { username: "CAL_USERNAME", password: "CAL_PASSWORD" }],
  ["max", { username: "MAX_USERNAME", password: "MAX_PASSWORD" }],
  ["isracard", { id: "ISRACARD_ID", card6Digits: "ISRACARD_CARD6", password: "ISRACARD_PASSWORD" }],
];

/**
 * @param env      process.env
 * @param scrapers the library's SCRAPERS map: { [companyId]: { name, loginFields: string[] } }
 * @returns { accounts: [{ key, company, name, credentials }], problems: [{ key, name, error }] }
 */
export function readAccounts(env, scrapers = {}) {
  const raw = [];
  const problems = [];
  if (env.BANK_CREDENTIALS && env.BANK_CREDENTIALS.trim()) {
    let parsed;
    try { parsed = JSON.parse(env.BANK_CREDENTIALS); }
    catch { problems.push({ key: "config", name: "הגדרות חיבור", error: "BANK_CREDENTIALS: JSON לא תקין. צור אותו מחדש במסך 'חיבור כרטיסים ובנקים' באפליקציה." }); parsed = []; }
    const list = Array.isArray(parsed) ? parsed : Object.entries(parsed || {}).map(([company, credentials]) => ({ company, credentials }));
    raw.push(...list);
  }
  for (const [company, map] of LEGACY) {
    if (raw.some((a) => a.company === company)) continue;
    const credentials = Object.fromEntries(Object.entries(map).map(([f, envName]) => [f, env[envName]]));
    if (Object.values(credentials).every(Boolean)) raw.push({ company, credentials });
  }

  const seen = {};
  const accounts = [];
  for (const a of raw) {
    const company = String(a?.company || "").trim();
    seen[company] = (seen[company] || 0) + 1;
    const key = seen[company] > 1 ? `${company}-${seen[company]}` : company;
    const name = a.label || COMPANY_NAMES[company] || company;
    const def = scrapers[company];
    if (!company || (Object.keys(scrapers).length && !def)) { problems.push({ key: key || "unknown", name, error: /visa|master|diners/i.test(company) && company !== "visaCal" ? `"${company}" היא רשת סליקה, לא חברת אשראי. בחר את מי שהנפיק את הכרטיס: כאל, מקס או ישראכרט.` : `חברה לא מוכרת: "${company}"` }); continue; }
    const creds = a.credentials || {};
    const fields = def?.loginFields || Object.keys(creds);
    const missing = fields.filter((f) => typeof f === "string" && !String(creds[f] ?? "").trim());
    if (missing.length) { problems.push({ key, name, error: `חסרים שדות: ${missing.join(", ")}` }); continue; }
    accounts.push({ key, company, name, credentials: creds });
  }
  return { accounts, problems };
}

/** "all" or a comma list of companies / keys (e.g. "visaCal" also matches "visaCal-2"). */
export function pickAccounts(accounts, wanted = "all") {
  const w = String(wanted || "all").split(",").map((x) => x.trim()).filter(Boolean);
  if (!w.length || w.includes("all")) return accounts;
  return accounts.filter((a) => w.includes(a.key) || w.includes(a.company));
}
