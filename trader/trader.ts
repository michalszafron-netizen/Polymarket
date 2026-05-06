/**
 * KRONOS TRADER — Silnik wykonywania zleceń na Polymarket CLOB
 *
 * TRYBY:
 *   DRY_RUN=true  (domyślny) → symuluje, nie wydaje pieniędzy
 *   DRY_RUN=false             → prawdziwy handel
 *
 * Wywołanie z bot.ts:
 *   const result = await trader.execute(edge);
 */

import { TRADER_CONFIG as CFG } from "./config.js";

// ── Typy ──────────────────────────────────────────────────────────────────

export interface EdgeSignal {
  market:     string;   // "BTC 5-Min Up/Down"
  direction:  "UP" | "DOWN";
  confidence: number;   // 0-1
  yes_price:  number;   // aktualna cena YES z Polymarket
  ev:         number;   // Expected Value (0.08 = 8%)
  kelly:      number;   // Kelly fraction (0-1)
  tokenId:    string;   // YES token ID z Polymarket
}

export interface TradeResult {
  status:    "executed" | "dry-run" | "skipped" | "error";
  reason?:   string;
  orderId?:  string;
  side:      "YES" | "NO";
  price:     number;
  sizeUsd:   number;
  payout:    number;
  expectedPnl: number;
}

// ── Risk checks ──────────────────────────────────────────────────────────

function validateEdge(edge: EdgeSignal): { ok: boolean; reason?: string } {
  if (edge.confidence < CFG.minConfidence)
    return { ok: false, reason: `Confidence ${(edge.confidence*100).toFixed(0)}% < min ${CFG.minConfidence*100}%` };

  if (edge.ev < CFG.minEv)
    return { ok: false, reason: `EV ${(edge.ev*100).toFixed(1)}% < min ${CFG.minEv*100}%` };

  if (edge.yes_price < CFG.validPriceMin || edge.yes_price > CFG.validPriceMax)
    return { ok: false, reason: `Cena YES ${edge.yes_price.toFixed(3)} poza zakresem ${CFG.validPriceMin}-${CFG.validPriceMax}` };

  return { ok: true };
}

function calcPositionSize(edge: EdgeSignal, bankrollUsd: number): number {
  // Kelly * bankroll * kellyFraction, ale max maxPositionUsd
  const kellySize = edge.kelly * bankrollUsd * CFG.kellyFraction;
  const pctSize   = bankrollUsd * CFG.maxBankrollPct;
  return Math.min(kellySize, pctSize, CFG.maxPositionUsd);
}

// ── CLOB Order execution ─────────────────────────────────────────────────

async function submitOrder(
  tokenId:  string,
  side:     "BUY",
  price:    number,
  sizeUsdc: number
): Promise<string> {
  // Importy dynamiczne — clob-client musi być zainstalowany
  const { ClobClient }   = await import("@polymarket/clob-client");
  const { Wallet }       = await import("ethers");

  const wallet = new Wallet(CFG.privateKey);
  const client = new ClobClient(
    CFG.clobApiUrl,
    CFG.chainId,
    wallet,
    { key: CFG.apiKey, secret: CFG.apiSecret, passphrase: CFG.apiPassphrase }
  );

  const order = await client.createOrder({
    tokenID:   tokenId,
    side:      side,
    price:     price,
    size:      sizeUsdc / price, // liczba tokenów = USDC / cena
  });

  const resp = await client.postOrder(order, "GTC"); // Good Till Cancelled
  return resp.orderID ?? "unknown";
}

// ── Główna funkcja ────────────────────────────────────────────────────────

export async function execute(
  edge:        EdgeSignal,
  bankrollUsd: number = 100
): Promise<TradeResult> {
  // Określ który token kupujemy
  const side      = edge.direction === "UP" ? "YES" : "NO";
  const betPrice  = edge.direction === "UP" ? edge.yes_price : (1 - edge.yes_price);
  const sizeUsd   = calcPositionSize(edge, bankrollUsd);
  const payout    = sizeUsd / betPrice;
  const expectedPnl = sizeUsd * edge.ev;

  // Walidacja
  const check = validateEdge(edge);
  if (!check.ok) {
    return { status: "skipped", reason: check.reason, side, price: betPrice, sizeUsd: 0, payout: 0, expectedPnl: 0 };
  }

  console.log(`\n  💰 TRADE SIGNAL:`);
  console.log(`     Rynek:    ${edge.market}`);
  console.log(`     Kierunek: ${side} (${edge.direction})`);
  console.log(`     Cena:     ${betPrice.toFixed(3)} → payout ${(1/betPrice).toFixed(2)}x`);
  console.log(`     Rozmiar:  $${sizeUsd.toFixed(2)}`);
  console.log(`     EV:       +${(edge.ev*100).toFixed(1)}%  |  Kelly: ${(edge.kelly*100).toFixed(1)}%`);
  console.log(`     Expected: +$${expectedPnl.toFixed(2)}`);

  // DRY RUN — tylko symulacja
  if (CFG.dryRun) {
    console.log(`     Status:   🧪 DRY RUN — zlecenie NIE zostało wysłane`);
    console.log(`               Ustaw DRY_RUN=false w .env żeby handlować live\n`);
    return { status: "dry-run", side, price: betPrice, sizeUsd, payout, expectedPnl };
  }

  // LIVE — prawdziwe zlecenie
  try {
    const tokenId = edge.direction === "UP"
      ? edge.tokenId                          // YES token
      : edge.tokenId.replace("YES", "NO");    // NO token (uproszczenie)

    const orderId = await submitOrder(tokenId, "BUY", betPrice, sizeUsd);
    console.log(`     Status:   ✅ ZLECENIE WYSŁANE | ID: ${orderId}\n`);
    return { status: "executed", orderId, side, price: betPrice, sizeUsd, payout, expectedPnl };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`     Status:   ❌ BŁĄD: ${msg}\n`);
    return { status: "error", reason: msg, side, price: betPrice, sizeUsd: 0, payout: 0, expectedPnl: 0 };
  }
}
