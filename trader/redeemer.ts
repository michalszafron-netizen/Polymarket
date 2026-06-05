/**
 * KRONOS REDEEMER — Auto-odkup wygranych pozycji Polymarket
 *
 * Prawidłowy mechanizm V3:
 *   EOA podpisuje Batch (EIP-712, verifyingContract = depositWallet)
 *   → DepositWallet.execute(batch, sig) — wywoływane bezpośrednio przez właściciela EOA
 *   → CtfCollateralAdapter.redeemPositions() → pUSD wraca do portfela
 *
 * V2 błędnie wywoływało DepositWalletFactory.proxy() — ten ma modifier onlyOperator,
 * EOA nie jest operatorem → revert 0x27e1f1e5.
 */

import { TRADER_CONFIG as CFG } from "./config.js";

const DATA_API = "https://data-api.polymarket.com";

// ── Kontrakty Polymarket V2 na Polygon ──────────────────────────────────────

const CTF_ADAPTER     = "0xAdA100Db00Ca00073811820692005400218FcE1f" as const;
const PUSD            = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const ZERO_BYTES32    = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const RPC             = "https://polygon-bor-rpc.publicnode.com";

// DepositWallet — execute(Batch, bytes) callable by owner EOA directly
// (DepositWalletFactory.proxy() jest onlyOperator — EOA nie może go wywołać)
const WALLET_EXECUTE_ABI = [
  {
    name: "execute",
    type: "function",
    inputs: [
      {
        name: "_batch", type: "tuple",
        components: [
          { name: "wallet",   type: "address" },
          { name: "nonce",    type: "uint256" },
          { name: "deadline", type: "uint256" },
          {
            name: "calls", type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value",  type: "uint256" },
              { name: "data",   type: "bytes"   },
            ],
          },
        ],
      },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// DepositWallet (proxy) — nonce() do podpisywania batchy
const WALLET_ABI = [
  {
    name: "nonce",
    type: "function",
    inputs: [],
    outputs: [{ name: "nonce_", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

// CtfCollateralAdapter — wraps CTF.redeemPositions + konwertuje na pUSD
const ADAPTER_ABI = [
  {
    name: "redeemPositions",
    type: "function",
    inputs: [
      { name: "",             type: "address"   },  // collateral (pUSD)
      { name: "",             type: "bytes32"   },  // parentCollectionId (zero)
      { name: "_conditionId", type: "bytes32"   },
      { name: "",             type: "uint256[]" },  // indexSets
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// EIP-712 typy dla batcha proxy wallet
const EIP712_TYPES = {
  Batch: [
    { name: "wallet",   type: "address" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls",    type: "Call[]"  },
  ],
  Call: [
    { name: "target", type: "address" },
    { name: "value",  type: "uint256" },
    { name: "data",   type: "bytes"   },
  ],
} as const;

// ────────────────────────────────────────────────────────────────────────────

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
      size:        p.size ?? 0,
      outcome:     p.outcome ?? "Yes",
      title:       p.title,
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

  const { createPublicClient, createWalletClient, http, encodeFunctionData } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { polygon } = await import("viem/chains");

  const account      = privateKeyToAccount(CFG.privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: polygon, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(RPC) });

  // Pobierz nonce deposit wallet (zarządza własnym nonce dla batch-sygnatury)
  const walletNonce = await publicClient.readContract({
    address:      CFG.proxyWallet as `0x${string}`,
    abi:          WALLET_ABI,
    functionName: "nonce",
    args:         [],
  });

  console.log(`     [REDEEMER] depositWallet nonce=${walletNonce}`);

  // Zakoduj każdą pozycję jako Call do CtfCollateralAdapter
  const calls = positions.map(pos => {
    const outcomeL = pos.outcome.toLowerCase();
    // API zwraca "Up"/"Down" albo "Yes"/"No" — oba mapujemy poprawnie
    const isYes    = outcomeL === "yes" || outcomeL === "up";
    const indexSet = isYes ? 1n : 2n;
    const label    = pos.title ?? `${pos.conditionId.slice(0, 12)}...`;

    console.log(`     → ${label} (${pos.outcome}, ${pos.size} shares, indexSet=${indexSet})`);

    const data = encodeFunctionData({
      abi:          ADAPTER_ABI,
      functionName: "redeemPositions",
      args: [
        PUSD          as `0x${string}`,
        ZERO_BYTES32  as `0x${string}`,
        pos.conditionId as `0x${string}`,
        [indexSet],
      ],
    });

    return {
      target: CTF_ADAPTER as `0x${string}`,
      value:  0n,
      data,
    };
  });

  // Deadline: 1 godzina od teraz
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const batchMessage = {
    wallet:   CFG.proxyWallet as `0x${string}`,
    nonce:    walletNonce,
    deadline,
    calls,
  };

  // Podpisz Batch EIP-712 — domena potwierdzona z @polymarket/builder-relayer-client
  // DEPOSIT_WALLET_DOMAIN_NAME="DepositWallet", VERSION="1", verifyingContract=depositWallet
  const signature = await walletClient.signTypedData({
    domain: {
      name:              "DepositWallet",
      version:           "1",
      chainId:           137n,
      verifyingContract: CFG.proxyWallet as `0x${string}`,
    },
    types:       EIP712_TYPES,
    primaryType: "Batch",
    message:     batchMessage,
  });

  console.log(`     [REDEEMER] batch podpisany (${calls.length} calls)`);

  // Nonce EOA dla on-chain tx (nie mylić z nonce depositWallet)
  const txNonce = await publicClient.getTransactionCount({
    address:  account.address,
    blockTag: "latest",
  });

  try {
    const hash = await walletClient.writeContract({
      address:      CFG.proxyWallet as `0x${string}`,
      abi:          WALLET_EXECUTE_ABI,
      functionName: "execute",
      args:         [batchMessage, signature],
      nonce:        txNonce,
    });

    console.log(`  ✅ [REDEEMER] tx wysłane: ${hash}`);
    console.log(`  [REDEEMER] ${positions.length} pozycji batch → czekam na potwierdzenie\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ [REDEEMER] błąd tx: ${msg.slice(0, 400)}\n`);
  }
}
