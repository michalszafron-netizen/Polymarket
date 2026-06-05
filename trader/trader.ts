/**
 * KRONOS TRADER — Silnik wykonywania zleceń na Polymarket CLOB (V2 Exchange)
 *
 * TRYBY:
 *   DRY_RUN=true  (domyślny) → symuluje, nie wydaje pieniędzy
 *   DRY_RUN=false             → prawdziwy handel
 */

import { TRADER_CONFIG as CFG } from "./config.js";

// ── Typy ──────────────────────────────────────────────────────────────────

export interface EdgeSignal {
  market:     string;
  direction:  "UP" | "DOWN";
  confidence: number;
  yes_price:  number;
  ev:         number;
  kelly:      number;
  yesToken:   string;
  noToken:    string;
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
  const kellySize = edge.kelly * bankrollUsd * CFG.kellyFraction;
  const pctSize   = bankrollUsd * CFG.maxBankrollPct;
  return Math.min(kellySize, pctSize, CFG.maxPositionUsd);
}

// ── Polymarket V2 order submission via official clob-client-v2 ───────────

async function submitOrder(
  tokenId:  string,
  price:    number,
  sizeUsdc: number
): Promise<string> {
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { ClobClient, Chain, Side, OrderType, SignatureTypeV2 } =
    await import("@polymarket/clob-client-v2");

  const account    = privateKeyToAccount(CFG.privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, transport: http("https://rpc.ankr.com/polygon") });

  const client = new ClobClient({
    host:            CFG.clobApiUrl,
    chain:           Chain.POLYGON,
    signer:          walletClient,
    signatureType:   SignatureTypeV2.POLY_1271,
    funderAddress:   CFG.proxyWallet,   // deposit wallet address from .env
    creds: {
      key:        CFG.apiKey,
      secret:     CFG.apiSecret,
      passphrase: CFG.apiPassphrase,
    },
  });

  const size = Math.max(parseFloat((sizeUsdc / price).toFixed(2)), 5);
  console.log(`     [DBG] tokenId=${tokenId} price=${price} size=${size}`);

  const resp = await client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.BUY, size },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTC,
  );

  console.log(`     [CLOB v2] ${JSON.stringify(resp).slice(0, 300)}`);

  const r = resp as { orderID?: string; error?: string };
  if (r.error) throw new Error(r.error);
  return r.orderID ?? "submitted";
}

// ── Główna funkcja ────────────────────────────────────────────────────────

export async function execute(
  edge:        EdgeSignal,
  bankrollUsd: number = 100
): Promise<TradeResult> {
  const side      = edge.direction === "UP" ? "YES" : "NO";
  const betPrice  = edge.direction === "UP" ? edge.yes_price : (1 - edge.yes_price);
  const sizeUsd   = calcPositionSize(edge, bankrollUsd);
  const payout    = sizeUsd / betPrice;
  const expectedPnl = sizeUsd * edge.ev;

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

  if (CFG.dryRun) {
    console.log(`     Status:   🧪 DRY RUN — zlecenie NIE zostało wysłane`);
    console.log(`               Ustaw DRY_RUN=false w .env żeby handlować live\n`);
    return { status: "dry-run", side, price: betPrice, sizeUsd, payout, expectedPnl };
  }

  try {
    const tokenId = edge.direction === "UP" ? edge.yesToken : edge.noToken;
    const orderId = await submitOrder(tokenId, betPrice, sizeUsd);
    console.log(`     Status:   ✅ ZLECENIE WYSŁANE | ID: ${orderId}\n`);
    return { status: "executed", orderId, side, price: betPrice, sizeUsd, payout, expectedPnl };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`     Status:   ❌ BŁĄD: ${msg}\n`);
    return { status: "error", reason: msg, side, price: betPrice, sizeUsd: 0, payout: 0, expectedPnl: 0 };
  }
}
