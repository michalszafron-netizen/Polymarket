/**
 * KRONOS STRIKE LADDER MONITOR — Edge #3
 *
 * Co 30 min:
 *   1. Pobiera wszystkie aktywne drabiny strajków BTC/ETH z Polymarket
 *      (rynki "Bitcoin/Ethereum price on <date>" — 11 koszyków $X szerokich,
 *      rozstrzygane ~7 dni po otwarciu, nowa drabina każdego dnia)
 *   2. Dla każdej granicy strajku liczy P(cena > K) wg Polymarket (suma YES
 *      koszyków powyżej K)
 *   3. Pobiera odpowiadający łańcuch opcji z Deribit (publiczne API, tylko
 *      odczyt — NIE handlujemy na Deribit, to czysto źródło danych)
 *   4. Liczy P(cena > K) wg opcji (Black-76, N(d2) z mark_iv Deribit)
 *   5. Loguje obie probabilities + gap do strike_ladder_log
 *
 * Teza: Polymarket retail systematycznie błędnie wycenia drabinę względem
 * rozkładu implikowanego przez rynek opcji. Niezależne od mikrostruktury
 * 5-Min/15-Min (Edge #1/#2 obalone) — handel na horyzoncie dni, nie sekund.
 *
 * Start: `npx tsx scanner/strike-ladder-monitor.ts`
 */

import Database from "better-sqlite3";
import { resolve } from "path";

// ─── Config ────────────────────────────────────────────────────────────────

const CFG = {
  dbPath: resolve(import.meta.dirname, "..", "kronos.db"),
  pollIntervalMs: 30 * 60 * 1000, // 30 min — rynek się rusza w godzinach/dniach
  gamma: "https://gamma-api.polymarket.com",
  deribit: "https://www.deribit.com/api/v2",
  assets: [
    { name: "BTC", seriesId: "10041", deribitCurrency: "BTC" },
    { name: "ETH", seriesId: "10065", deribitCurrency: "ETH" },
  ],
  maxDeribitDateOffsetDays: 1.5, // ile dni różnicy od idealnego expiry tolerujemy
};

// ─── DB ────────────────────────────────────────────────────────────────────

const db = new Database(CFG.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS strike_ladder_log (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                 TEXT NOT NULL,
    asset              TEXT NOT NULL,
    event_slug         TEXT NOT NULL,
    resolve_ts         TEXT NOT NULL,
    strike             REAL NOT NULL,
    pm_prob_above      REAL,
    deribit_prob_above REAL,
    gap_pp             REAL,
    deribit_iv         REAL,
    forward_price      REAL,
    spot_price         REAL,
    deribit_expiry_code TEXT,
    date_offset_days  REAL
  )
`);

const insertRow = db.prepare(`
  INSERT INTO strike_ladder_log (
    ts, asset, event_slug, resolve_ts, strike,
    pm_prob_above, deribit_prob_above, gap_pp,
    deribit_iv, forward_price, spot_price,
    deribit_expiry_code, date_offset_days
  ) VALUES (
    datetime('now'), ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    ?, ?
  )
`);

// ─── Normal CDF (Abramowitz-Stegun) ────────────────────────────────────────

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

// ─── Polymarket: drabina strajków ─────────────────────────────────────────

interface Bucket {
  lo: number | null;
  hi: number | null;
  yes: number;
}

interface Ladder {
  slug: string;
  endDate: string;
  buckets: Bucket[];
}

function parseBucket(question: string): { lo: number | null; hi: number | null } {
  const nums = (question.match(/[\d,]+(?:\.\d+)?/g) ?? [])
    .map((s) => parseFloat(s.replace(/,/g, "")));
  if (question.includes("between")) return { lo: nums[0], hi: nums[1] };
  if (question.includes("less than")) return { lo: null, hi: nums[0] };
  if (question.includes("greater than")) return { lo: nums[0], hi: null };
  throw new Error(`cannot parse bucket question: ${question}`);
}

async function fetchActiveLadders(seriesId: string): Promise<Ladder[]> {
  const res = await fetch(
    `${CFG.gamma}/events?series_id=${seriesId}&closed=false&limit=20`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  const events = (await res.json()) as Array<{
    slug: string;
    endDate: string;
    markets: Array<{ question: string; outcomePrices: string | string[] }>;
  }>;

  return events.map((ev) => ({
    slug: ev.slug,
    endDate: ev.endDate,
    buckets: ev.markets.map((m) => {
      const prices =
        typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const { lo, hi } = parseBucket(m.question);
      return { lo, hi, yes: parseFloat(prices[0]) };
    }),
  }));
}

function pmProbAbove(ladder: Ladder, K: number): number {
  return ladder.buckets
    .filter((b) => (b.lo ?? -Infinity) >= K - 1e-6)
    .reduce((sum, b) => sum + b.yes, 0);
}

function ladderBoundaries(ladder: Ladder): number[] {
  const set = new Set<number>();
  for (const b of ladder.buckets) {
    if (b.lo !== null) set.add(b.lo);
    if (b.hi !== null) set.add(b.hi);
  }
  return [...set].sort((a, b) => a - b);
}

// ─── Deribit: łańcuch opcji ────────────────────────────────────────────────

interface DeribitLeg {
  strike: number;
  type: "C" | "P";
  markIv: number; // jako fraction (0.50 = 50%)
  underlyingPrice: number;
}

interface DeribitChain {
  legs: DeribitLeg[];
  expiryCode: string;
  expiryDate: Date;
}

async function findBestDeribitExpiry(
  currency: string,
  targetDate: Date
): Promise<{ code: string; date: Date; offsetDays: number } | null> {
  const res = await fetch(
    `${CFG.deribit}/public/get_instruments?currency=${currency}&kind=option&expired=false`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    result: Array<{ instrument_name: string; expiration_timestamp: number }>;
  };

  const byCode = new Map<string, number>();
  for (const inst of data.result) {
    const code = inst.instrument_name.split("-")[1];
    byCode.set(code, inst.expiration_timestamp);
  }

  let best: { code: string; date: Date; offsetDays: number } | null = null;
  for (const [code, ts] of byCode) {
    const date = new Date(ts);
    const offsetDays = Math.abs(date.getTime() - targetDate.getTime()) / 86_400_000;
    if (!best || offsetDays < best.offsetDays) best = { code, date, offsetDays };
  }
  return best;
}

async function fetchDeribitChain(
  currency: string,
  expiryCode: string
): Promise<DeribitLeg[]> {
  const res = await fetch(
    `${CFG.deribit}/public/get_instruments?currency=${currency}&kind=option&expired=false`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    result: Array<{ instrument_name: string }>;
  };
  const names = data.result
    .map((i) => i.instrument_name)
    .filter((n) => n.split("-")[1] === expiryCode && n.endsWith("-C")); // tylko calle — wystarczą do N(d2)

  const tickers = await Promise.all(
    names.map(async (name) => {
      try {
        const r = await fetch(`${CFG.deribit}/public/ticker?instrument_name=${name}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const t = (await r.json()) as {
          result?: { mark_iv?: number; underlying_price?: number };
        };
        if (!t.result || t.result.mark_iv == null) return null;
        const parts = name.split("-");
        return {
          strike: parseFloat(parts[2]),
          type: "C" as const,
          markIv: t.result.mark_iv / 100,
          underlyingPrice: t.result.underlying_price!,
        };
      } catch {
        return null;
      }
    })
  );

  return tickers.filter((t): t is DeribitLeg => t !== null).sort((a, b) => a.strike - b.strike);
}

function deribitProbAbove(
  chain: DeribitLeg[],
  K: number,
  resolveDate: Date
): { prob: number; iv: number; forward: number } | null {
  if (chain.length === 0) return null;
  const forward = chain[0].underlyingPrice;

  let iv: number;
  if (K <= chain[0].strike) iv = chain[0].markIv;
  else if (K >= chain[chain.length - 1].strike) iv = chain[chain.length - 1].markIv;
  else {
    iv = chain[0].markIv;
    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i].strike <= K && K <= chain[i + 1].strike) {
        const w = (K - chain[i].strike) / (chain[i + 1].strike - chain[i].strike);
        iv = chain[i].markIv * (1 - w) + chain[i + 1].markIv * w;
        break;
      }
    }
  }

  const T = (resolveDate.getTime() - Date.now()) / (365.25 * 86_400_000);
  if (T <= 0 || iv <= 0) return null;

  const d2 = (Math.log(forward / K) - 0.5 * iv * iv * T) / (iv * Math.sqrt(T));
  return { prob: normCdf(d2), iv, forward };
}

// ─── Main poll cycle ───────────────────────────────────────────────────────

async function pollAsset(asset: typeof CFG.assets[number]): Promise<number> {
  let logged = 0;
  const ladders = await fetchActiveLadders(asset.seriesId);

  for (const ladder of ladders) {
    const resolveDate = new Date(ladder.endDate);
    const best = await findBestDeribitExpiry(asset.deribitCurrency, resolveDate);
    if (!best || best.offsetDays > CFG.maxDeribitDateOffsetDays) {
      console.log(
        `  ⏭️  ${asset.name} ${ladder.slug}: brak Deribit expiry w zasięgu ` +
        `(najbliższy offset ${best?.offsetDays.toFixed(1) ?? "N/A"}d)`
      );
      continue;
    }
    const chain = await fetchDeribitChain(asset.deribitCurrency, best.code);
    if (chain.length === 0) continue;

    const boundaries = ladderBoundaries(ladder);
    for (const K of boundaries) {
      const pmP = pmProbAbove(ladder, K);
      const db_ = deribitProbAbove(chain, K, resolveDate);
      if (!db_) continue;
      const gapPp = (pmP - db_.prob) * 100;

      insertRow.run(
        asset.name, ladder.slug, ladder.endDate, K,
        pmP, db_.prob, gapPp,
        db_.iv, db_.forward, chain[0].underlyingPrice,
        best.code, best.offsetDays
      );
      logged++;
    }
    console.log(
      `  ✅ ${asset.name} ${ladder.slug} (expiry Deribit ${best.code}, offset ${best.offsetDays.toFixed(1)}d): ` +
      `${boundaries.length} strajków zalogowanych`
    );
  }
  return logged;
}

async function runCycle(): Promise<void> {
  const ts = new Date().toISOString().slice(0, 19);
  console.log(`\n━━━ STRIKE LADDER CYCLE ${ts} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  let total = 0;
  for (const asset of CFG.assets) {
    try {
      total += await pollAsset(asset);
    } catch (err) {
      console.error(`  ❌ ${asset.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`━━━ ${total} wierszy zalogowanych ━━━`);
}

async function main(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════╗
║     KRONOS STRIKE LADDER MONITOR — Edge #3       ║
║     Polymarket drabina vs Deribit opcje          ║
╚══════════════════════════════════════════════════╝
`);
  console.log(`📂 Database: ${CFG.dbPath}`);
  console.log(`⏱️  Interval: ${CFG.pollIntervalMs / 60000} min\n`);

  await runCycle();
  setInterval(runCycle, CFG.pollIntervalMs);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
