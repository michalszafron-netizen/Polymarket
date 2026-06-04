/**
 * KRONOS REDEEMER — Auto-odkup wygranych pozycji Polymarket
 *
 * Wywołuje CTF.redeemPositions na Polygon dla każdej pozycji
 * gdzie redeemable=true w data API. Uruchamiany z bot.ts co 30 min.
 */

import { TRADER_CONFIG as CFG } from "./config.js";

const DATA_API = "https://data-api.polymarket.com";

// ConditionalTokens (CTF) — kontrakty Polymarket na Polygon
const CTF_ADDRESS    = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const;
const COLLATERAL     = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const; // USDC
const ZERO_BYTES32   = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

const CTF_ABI = [{
  name: "redeemPositions",
  type: "function",
  inputs: [
    { name: "collateralToken",    type: "address"   },
    { name: "parentCollectionId", type: "bytes32"   },
    { name: "conditionId",        type: "bytes32"   },
    { name: "indexSets",          type: "uint256[]" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
}] as const;

interface RedeemablePosition {
  conditionId: string;
  size: number;
  outcome: string;
  title?: string;
}

async function fetchRedeemable(): Promise<RedeemablePosition[]> {
  const url = `${DATA_API}/positions?user=${CFG.proxyWallet}&redeemable=true&sizeThreshold=.01`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`data-api HTTP ${res.status} ${res.statusText}`);

  const raw = await res.json() as Array<{
    conditionId?: string;
    size?: number;
    outcome?: string;
    redeemable?: boolean;
    title?: string;
  }>;

  return raw
    .filter(p => p.redeemable && (p.size ?? 0) > 0 && p.conditionId)
    .map(p => ({
      conditionId: p.conditionId!,
      size: p.size ?? 0,
      outcome: p.outcome ?? "Yes",
      title: p.title,
    }));
}

export async function runRedeemer(): Promise<void> {
  console.log("\n  🔄 [REDEEMER] sprawdzam wygranie pozycje...");

  let positions: RedeemablePosition[];
  try {
    positions = await fetchRedeemable();
  } catch (err) {
    console.warn(`  ⚠️  [REDEEMER] błąd API: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (positions.length === 0) {
    console.log("  ✅ [REDEEMER] brak pozycji do odkupienia\n");
    return;
  }

  console.log(`  💰 [REDEEMER] ${positions.length} pozycji do odkupienia`);

  if (CFG.dryRun) {
    for (const p of positions) {
      console.log(`     [DRY] ${p.title ?? p.conditionId.slice(0, 14)}... (${p.outcome}, ${p.size} shares)`);
    }
    console.log("     DRY_RUN=true — brak transakcji\n");
    return;
  }

  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  const account = privateKeyToAccount(CFG.privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-rpc.com"),
  });

  let redeemed = 0;
  for (const pos of positions) {
    try {
      // Binary CTF: YES token → indexSet=1 (0b01), NO token → indexSet=2 (0b10)
      const indexSet = pos.outcome.toLowerCase().startsWith("y") ? 1n : 2n;
      const label = pos.title ?? pos.conditionId.slice(0, 14) + "...";
      console.log(`     → ${label} (${pos.outcome}, ${pos.size} shares)`);

      const hash = await walletClient.writeContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: "redeemPositions",
        args: [COLLATERAL, ZERO_BYTES32, pos.conditionId as `0x${string}`, [indexSet]],
      });

      console.log(`     ✅ tx: ${hash}`);
      redeemed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`     ❌ błąd: ${msg.slice(0, 250)}`);
    }
  }

  console.log(`  [REDEEMER] zakończono — ${redeemed}/${positions.length} odkupiono\n`);
}
