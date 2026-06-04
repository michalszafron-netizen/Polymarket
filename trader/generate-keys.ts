/**
 * KRONOS — Generowanie kluczy API Polymarket
 *
 * Uruchom JEDEN raz żeby wygenerować API credentials:
 *   npx tsx trader/generate-keys.ts
 *
 * Wymagania:
 *   - POLY_PRIVATE_KEY w .env
 *   - npm install @polymarket/clob-client ethers dotenv
 *
 * Wynik: wypisuje POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE
 * Wklej je do .env
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "..", ".env") });

async function generateKeys() {
  const privateKey = process.env.POLY_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ Brakuje POLY_PRIVATE_KEY w .env");
    process.exit(1);
  }

  console.log("🔑 Generowanie kluczy API Polymarket...\n");

  try {
    // Dynamiczny import — biblioteka musi być zainstalowana
    const { ClobClient } = await import("@polymarket/clob-client");
    const { Wallet }     = await import("@ethersproject/wallet");

    const wallet = new Wallet(privateKey);
    console.log(`📍 Adres portfela: ${wallet.address}`);

    const client = new ClobClient(
      "https://clob.polymarket.com",
      137, // Polygon
      wallet
    );

    const apiCreds = await client.createApiKey();

    console.log("\n✅ Klucze wygenerowane! Wklej do .env:\n");
    console.log(`POLY_API_KEY=${apiCreds.key}`);
    console.log(`POLY_API_SECRET=${apiCreds.secret}`);
    console.log(`POLY_API_PASSPHRASE=${apiCreds.passphrase}`);
    console.log("\n⚠️  Zapisz te klucze — nie można ich odzyskać!");

  } catch (err) {
    if ((err as Error).message?.includes("Cannot find module")) {
      console.error("❌ Zainstaluj najpierw: npm install @polymarket/clob-client ethers");
    } else {
      console.error("❌ Błąd:", err);
    }
    process.exit(1);
  }
}

generateKeys();
