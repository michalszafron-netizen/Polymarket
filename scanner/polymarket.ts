/**
 * Polymarket CLOB price fetcher.
 *
 * Rynki BTC/ETH Up or Down mają slug z timestampem: btc-updown-5m-1778067600
 * Obliczamy aktualny slot i pobieramy cenę YES z CLOB midpoint.
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

// Cache: marketName → { tokenId, expiresAt }
const cache = new Map<string, { tokenId: string; expiresAt: number }>();

// ─── Oblicz aktualny slot czasowy ──────────────────────────────────────────

function currentSlots(intervalMin: number): number[] {
  const intervalSec = intervalMin * 60;
  const now = Math.floor(Date.now() / 1000);
  const current = Math.floor(now / intervalSec) * intervalSec;
  // Zwróć aktualny + poprzedni slot (rynek może być jeszcze aktywny)
  return [current, current - intervalSec, current + intervalSec];
}

// ─── Pobierz token ID przez slug ────────────────────────────────────────────

async function fetchTokenBySlug(slug: string): Promise<string | null> {
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
    return ids[0] ?? null; // [0] = YES token
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
    return isNaN(mid) || mid <= 0 || mid >= 1 ? null : mid;
  } catch {
    return null;
  }
}

// ─── Znajdź aktualny token ID dla rynku ────────────────────────────────────

async function findTokenId(marketName: string): Promise<string | null> {
  // Sprawdź cache
  const hit = cache.get(marketName);
  if (hit && hit.expiresAt > Date.now()) return hit.tokenId;

  const cfg = SLUG_PREFIX[marketName];
  if (!cfg) return null;

  // Próbuj kolejne sloty (aktualny, poprzedni, następny)
  for (const slot of currentSlots(cfg.intervalMin)) {
    const slug    = `${cfg.prefix}-${slot}`;
    const tokenId = await fetchTokenBySlug(slug);
    if (tokenId) {
      // Cache na 4 minuty
      cache.set(marketName, { tokenId, expiresAt: Date.now() + 4 * 60 * 1000 });
      return tokenId;
    }
  }

  return null;
}

// ─── Publiczny interfejs ────────────────────────────────────────────────────

export interface PolyPrice {
  yes:    number;
  source: "polymarket" | "simulated";
}

export async function getPolyPrice(marketName: string): Promise<PolyPrice | null> {
  const tokenId = await findTokenId(marketName);
  if (!tokenId) return null;

  const mid = await fetchMidpoint(tokenId);
  if (mid === null) return null;

  return { yes: mid, source: "polymarket" };
}
