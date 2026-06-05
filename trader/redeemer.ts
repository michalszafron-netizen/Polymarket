/**
 * KRONOS REDEEMER — Auto-odkup wygranych pozycji Polymarket
 *
 * Prawidłowy mechanizm V2:
 *   EOA podpisuje Batch (EIP-712, verifyingContract = depositWallet)
 *   → DepositWalletFactory.proxy() → DepositWallet
 *   → CtfCollateralAdapter.redeemPositions() → pUSD wraca do portfela
 *
 * Poprzednia wersja błędnie wywoływała CTF.redeemPositions() bezpośrednio
 * z EOA — CTF nie ma pozycji EOA, tylko depositWallet.
 */

import { TRADER_CONFIG as CFG } from "./config.js";

const DATA_API = "https://data-api.polymarket.com";

// ── Kontrakty Polymarket V2 na Polygon ──────────────────────────────────────

const FACTORY_ADDRESS = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07" as const;
const CTF_ADAPTER     = "0xAdA100Db00Ca00073811820692005400218FcE1f" as const;
const PUSD            = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const ZERO_BYTES32    = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
const RPC             = "https://polygon-bor-rpc.publicnode.com";

// DepositWalletFactory — proxy(Batch[], bytes[]) + nonce na deposit wallet
const FACTORY_ABI = [
  {
    name: "proxy",
    type: "function",
    inputs: [
      {
        name: "_batches", type: "tuple[]",
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
      { name: "_signatures", type: "bytes[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// DepositWallet (proxy) — nonce() i eip712Domain() do podpisywania batchy
const WALLET_ABI = [
  {
    name: "nonce",
    type: "function",
    inputs: [],
    outputs: [{ name: "nonce_", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "eip712Domain",
    type: "function",
    inputs: [],
    outputs: [
      { name: "fields",            type: "bytes1"    },
      { name: "name",              type: "string"    },
      { name: "version",           type: "string"    },
      { name: "chainId",           type: "uint256"   },
      { name: "verifyingContract", type: "address"   },
      { name: "salt",              type: "bytes32"   },
      { name: "extensions",        type: "uint256[]" },
    ],
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

  // Pobierz nonce i domenę EIP-712 bezpośrednio z deposit wallet
  const [walletNonce, domainData] = await Promise.all([
    publicClient.readContract({
      address:      CFG.proxyWallet as `0x${string}`,
      abi:          WALLET_ABI,
      functionName: "nonce",
      args:         [],
    }),
    publicClient.readContract({
      address:      CFG.proxyWallet as `0x${string}`,
      abi:          WALLET_ABI,
      functionName: "eip712Domain",
      args:         [],
    }),
  ]);

  const [, domainName, domainVersion, domainChainId, domainContract] = domainData as [
    string, string, string, bigint, string, string, bigint[]
  ];

  console.log(`     [REDEEMER] depositWallet nonce=${walletNonce}, domain="${domainName}" v${domainVersion}`);

  // Zakoduj każdą pozycję jako Call do CtfCollateralAdapter
  const calls = positions.map(pos => {
    const isYes    = pos.outcome.toLowerCase().startsWith("y");
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

  // Podpisz Batch EIP-712 — domena z kontraktu deposit wallet (dynamicznie)
  const signature = await walletClient.signTypedData({
    domain: {
      name:              domainName,
      version:           domainVersion,
      chainId:           domainChainId,
      verifyingContract: (domainContract || CFG.proxyWallet) as `0x${string}`,
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
      address:      FACTORY_ADDRESS,
      abi:          FACTORY_ABI,
      functionName: "proxy",
      args:         [[batchMessage], [signature]],
      nonce:        txNonce,
    });

    console.log(`  ✅ [REDEEMER] tx wysłane: ${hash}`);
    console.log(`  [REDEEMER] ${positions.length} pozycji batch → czekam na potwierdzenie\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ [REDEEMER] błąd tx: ${msg.slice(0, 400)}\n`);
  }
}
