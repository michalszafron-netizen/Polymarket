/**
 * KRONOS TRADER — Silnik wykonywania zleceń na Polymarket CLOB (V2 Exchange)
 *
 * TRYBY:
 *   DRY_RUN=true  (domyślny) → symuluje, nie wydaje pieniędzy
 *   DRY_RUN=false             → prawdziwy handel
 */

import { createHmac } from "node:crypto";
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

// ── HMAC helper ─────────────────────────────────────────────────────────

function buildHmac(secret: string, ts: number, method: string, path: string, body: string): string {
  const message = `${ts}${method}${path}${body}`;
  const key = Buffer.from(secret, "base64");
  const sig = createHmac("sha256", key).update(message).digest("base64");
  return sig.replace(/\+/g, "-").replace(/\//g, "_");
}

// ── Polymarket V2 order signing + submission ──────────────────────────────

// New V2 exchange: version "2", new 11-field struct (no taker/nonce/feeRateBps, adds timestamp/metadata/builder).
// Payload requires deferExec:false and salt as integer (schema validation).
const EXCHANGE_V2  = "0xE111180000d2663C0091e4f400237545B87B996B";
const ZERO_BYTES32 = "0x" + "00".repeat(32);
const ORDER_TYPES = {
  Order: [
    { name: "salt",          type: "uint256" },
    { name: "maker",         type: "address" },
    { name: "signer",        type: "address" },
    { name: "tokenId",       type: "uint256" },
    { name: "makerAmount",   type: "uint256" },
    { name: "takerAmount",   type: "uint256" },
    { name: "side",          type: "uint8"   },
    { name: "signatureType", type: "uint8"   },
    { name: "timestamp",     type: "uint256" },
    { name: "metadata",      type: "bytes32" },
    { name: "builder",       type: "bytes32" },
  ],
} as const;

async function submitOrder(
  tokenId:  string,
  price:    number,
  sizeUsdc: number
): Promise<string> {
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(CFG.privateKey);

  // Amounts in micro-units (6 decimals), BUY: maker pays USDC, gets tokens
  const tokensRaw     = Math.floor((sizeUsdc / price) * 100) / 100;  // round down to 2 dp
  const takerAmount   = String(Math.round(tokensRaw * 1e6));          // conditional tokens
  const makerAmount   = String(Math.round(tokensRaw * price * 1e6));  // USDC

  const salt          = String(Math.floor(Math.random() * 1e15));
  const orderTs      = Math.floor(Date.now() / 1000);  // seconds
  const hmacTimestamp = orderTs;

  const orderToSign = {
    salt,
    maker:         CFG.proxyWallet,
    signer:        wallet.address,
    tokenId,
    makerAmount,
    takerAmount,
    side:          0,           // BUY = 0
    signatureType: 2,           // POLY_PROXY
    timestamp:     String(orderTs),
    metadata:      ZERO_BYTES32,
    builder:       ZERO_BYTES32,
  };

  const domain = {
    name:              "Polymarket CTF Exchange",
    version:           "2",
    chainId:           137,
    verifyingContract: EXCHANGE_V2,
  };

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderToSign);
  console.log(`     [DBG] payload salt=${salt} maker=${CFG.proxyWallet} tokenId=${tokenId}`);

  const payload = {
    deferExec: false,
    order: {
      salt:          parseInt(salt, 10),
      maker:         CFG.proxyWallet,
      signer:        wallet.address,
      tokenId,
      makerAmount,
      takerAmount,
      side:          "BUY",
      signatureType: 2,
      timestamp:     orderTs,
      metadata:      ZERO_BYTES32,
      builder:       ZERO_BYTES32,
      signature,
    },
    owner:     CFG.apiKey,
    orderType: "GTC",
  };

  const bodyStr = JSON.stringify(payload);
  console.log(`     [DBG BODY] ${bodyStr}`);
  const hmacSig = buildHmac(CFG.apiSecret, hmacTimestamp, "POST", "/order", bodyStr);

  const headers: Record<string, string> = {
    "Content-Type":   "application/json",
    POLY_ADDRESS:     wallet.address,
    POLY_SIGNATURE:   hmacSig,
    POLY_TIMESTAMP:   String(hmacTimestamp),
    POLY_API_KEY:     CFG.apiKey,
    POLY_PASSPHRASE:  CFG.apiPassphrase,
  };

  const resp = await fetch(`${CFG.clobApiUrl}/order`, {
    method: "POST",
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(10000),
  });

  const raw = await resp.text();
  console.log(`     [CLOB] ${resp.status}: ${raw.slice(0, 300)}`);

  let result: { orderID?: string; error?: string; errorCode?: string };
  try { result = JSON.parse(raw); } catch { throw new Error(`Non-JSON response: ${raw.slice(0, 200)}`); }

  if (result.error || result.errorCode)
    throw new Error(String(result.error ?? result.errorCode));

  return result.orderID ?? "submitted";
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
