/**
 * KRONOS TRADER — Konfiguracja live trading
 *
 * Jak wypełnić:
 * 1. Skopiuj .env.example → .env
 * 2. Wpisz dane z MetaMask i Polymarket
 * 3. Nigdy nie commituj .env do git!
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "..", ".env") });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Brakuje zmiennej środowiskowej: ${key}`);
  return val;
}

export const TRADER_CONFIG = {
  // ── Polymarket CLOB ──────────────────────────────────────────
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",

  // ── Credentials (z .env) ─────────────────────────────────────
  get privateKey()   { return requireEnv("POLY_PRIVATE_KEY"); },
  get apiKey()       { return requireEnv("POLY_API_KEY"); },
  get apiSecret()    { return requireEnv("POLY_API_SECRET"); },
  get apiPassphrase(){ return requireEnv("POLY_API_PASSPHRASE"); },
  // Proxy wallet — adres Polymarket Safe (nie EOA MetaMask)
  // Znaleźć: polymarket.com → kliknij ikonę portfela (prawy górny róg)
  get proxyWallet()  { return requireEnv("POLY_PROXY_ADDRESS"); },

  chainId: 137, // Polygon mainnet

  // ── Limity ryzyka ─────────────────────────────────────────────
  maxPositionUsd:   5.0,    // Min 5 tokenów wymagane przez Polymarket (~$2.25 przy cenie 0.45)
  maxOpenPositions: 3,      // Max 3 otwarte pozycje jednocześnie
  minEv:            0.08,   // Min 8% EV żeby wejść
  // Platt-calibrated confidence jest ~0.44-0.56 — nie filtrujemy powyżej 50%,
  // EV już uwzględnia confidence matematycznie
  minConfidence:    0.50,   // Min 50% (wystarczy — EV filtruje resztę)
  kellyFraction:    0.25,   // Używaj max 25% sugerowanego Kelly
  maxBankrollPct:   0.02,   // Max 2% bankrolla na jeden trade

  // ── Filtry ────────────────────────────────────────────────────
  validPriceMin:    0.05,   // Nie handluj gdy YES < 5 centów
  validPriceMax:    0.95,   // Nie handluj gdy YES > 95 centów
  minLiquidityUsd:  100,    // Min $100 wolumenu na rynku

  // ── Dry run ───────────────────────────────────────────────────
  dryRun: process.env.DRY_RUN !== "false", // domyślnie DRY RUN = bezpieczne
};
