/**
 * Polymarket CLOB price fetcher.
 *
 * Rynki BTC/ETH Up or Down mają slug z timestampem: btc-updown-5m-1778067600
 * Obliczamy aktualny slot i pobieramy cenę YES z CLOB midpoint.
 * Od v2: pobieramy też best bid/ask z /book dla obu tokenów (YES i NO).
 */

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB  = "https://clob.polymarket.com";

// Mapowanie wewnętrznych nazw → prefix sluga na Polymarket
const SLUG_PREFIX: Record<string, { prefix: string; intervalMin: number }> = {
  "BTC 5-Min Up/Down":  { prefix: "btc-updown-5m",  intervalMin: 5  },
  "ETH 5-Min Up/Down":  { prefix: "eth-updown-5m",  intervalMin: 5  },
  "BTC 15-Min Up/Down": { prefix: "btc-updown-15m", intervalMin: 15 },
  "ETH 15-Min Up/Down": { prefix: "eth-updown-15m", intervalMin: 15 },
};

// Cache: marketName → { tokenIds: [yes, no], expiresAt }
const cache = new Map<string, { tokenIds: [string, string]; expiresAt: number }>();

// ─── Oblicz aktualny slot czasowy ──────────────────────────────────────────

function currentSlots(intervalMin: number): number[] {
  const intervalSec = intervalMin * 60;
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / intervalSec) * intervalSec;
  // Tylko aktualny i następny slot — poprzedni jest rozliczany (cena ~0.001 lub ~0.999)
  return [current, current + intervalSec];
}

// ─── Pobierz token ID przez slug ────────────────────────────────────────────

async function fetchTokensBySlug(slug: string): Promise<[string, string] | null> {
  try {
    const res = await fetch(`${GAMMA}/events?slug=${slug}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const events = await res.json() as Array<{
      markets?: Array<{ clobTokenIds?: string | string[] }>;
    }>;

    if (!events || events.length === 0) return null;
    const market = events[0]?.markets?.[0];
    if (!market?.clobTokenIds) return null;

    const ids = parseTokenIds(market.clobTokenIds);
    if (ids.length < 2) return null;
    return [ids[0], ids[1]]; // [0] = YES, [1] = NO
  } catch {
    return null;
  }
}

function parseTokenIds(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

// ─── Pobierz midpoint z CLOB ───────────────────────────────────────────────

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  try {
    const res = await fetch(`${CLOB}/midpoint?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { mid?: string };
    const mid = parseFloat(data.mid ?? "");
    // Odrzuć ceny ekstremalne — rozliczony rynek ma cenę ~0.001 lub ~0.999
    return isNaN(mid) || mid < 0.05 || mid > 0.95 ? null : mid;
  } catch {
    return null;
  }
}

// ─── Pobierz best bid/ask z CLOB (/book endpoint) ─────────────────────────

interface BookSide { bid: number | null; ask: number | null; }

async function fetchBestBidAsk(tokenId: string): Promise<BookSide> {
  try {
    const res = await fetch(`${CLOB}/book?token_id=${tokenId}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { bid: null, ask: null };
    const data = await res.json() as {
      bids?: Array<{ price: string; size: string }>;
      asks?: Array<{ price: string; size: string }>;
    };
    // Polymarket CLOB returns bids ASC (lowest first) and asks DESC (highest first).
    // Best bid = last element of bids, best ask = last element of asks.
    const bids = data.bids ?? [];
    const asks = data.asks ?? [];
    const bid = bids.length ? parseFloat(bids[bids.length - 1].price) : null;
    const ask = asks.length ? parseFloat(asks[asks.length - 1].price) : null;
    return {
      bid: bid !== null && !isNaN(bid) ? bid : null,
      ask: ask !== null && !isNaN(ask) ? ask : null,
    };
  } catch {
    return { bid: null, ask: null };
  }
}

// ─── Znajdź aktualny token ID dla rynku ────────────────────────────────────

async function findTokenIds(marketName: string): Promise<[string, string] | null> {
  const hit = cache.get(marketName);
  if (hit && hit.expiresAt > Date.now()) return hit.tokenIds;

  const cfg = SLUG_PREFIX[marketName];
  if (!cfg) return null;

  for (const slot of currentSlots(cfg.intervalMin)) {
    const slug   = `${cfg.prefix}-${slot}`;
    const tokens = await fetchTokensBySlug(slug);
    if (tokens) {
      cache.set(marketName, { tokenIds: tokens, expiresAt: Date.now() + 4 * 60 * 1000 });
      return tokens;
    }
  }

  return null;
}

// ─── Publiczny interfejs ────────────────────────────────────────────────────

export interface PolyPrice {
  yes:       number;
  yesToken:  string;
  noToken:   string;
  source:    "polymarket" | "simulated";
  // Spread data — null jeśli /book był niedostępny
  yesBid:    number | null;
  yesAsk:    number | null;
  noBid:     number | null;
  noAsk:     number | null;
}

export async function getPolyPrice(marketName: string): Promise<PolyPrice | null> {
  const tokens = await findTokenIds(marketName);
  if (!tokens) return null;

  let mid = await fetchMidpoint(tokens[0]);

  // Cena null = stary/rozliczony rynek w cache — inwaliduj i spróbuj ponownie
  if (mid === null) {
    cache.delete(marketName);
    const fresh = await findTokenIds(marketName);
    if (!fresh) return null;
    mid = await fetchMidpoint(fresh[0]);
    if (mid === null) return null;
    tokens[0] = fresh[0];
    tokens[1] = fresh[1];
  }
  if (mid === null) return null;

  // Pobierz book dla obu tokenów równolegle (best bid/ask dla spreadu)
  const [yesBook, noBook] = await Promise.all([
    fetchBestBidAsk(tokens[0]),
    fetchBestBidAsk(tokens[1]),
  ]);

  return {
    yes:      mid,
    yesToken: tokens[0],
    noToken:  tokens[1],
    source:   "polymarket",
    yesBid:   yesBook.bid,
    yesAsk:   yesBook.ask,
    noBid:    noBook.bid,
    noAsk:    noBook.ask,
  };
}
