/**
 * KRONOS — znajdź proxy wallet address
 * Uruchom: cd /root/kronos && npx tsx trader/find-proxy.ts
 */

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "..", ".env") });

const EOA = "0xD3B053d28eE08eE49d7C124A2FD3B054883e4476";

async function tryFetch(label: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const text = await res.text();
    console.log(`\n[${label}] status=${res.status}`);
    if (res.ok) {
      try {
        const j = JSON.parse(text);
        console.log(JSON.stringify(j).slice(0, 1000));
      } catch {
        console.log(text.slice(0, 500));
      }
    } else {
      console.log(text.slice(0, 200));
    }
  } catch (e: unknown) {
    console.log(`[${label}] error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  console.log(`\nEOA: ${EOA}\n`);

  // 1. Gamma — profile
  await tryFetch("gamma/profile",    `https://gamma-api.polymarket.com/profile?user=${EOA}`);
  await tryFetch("gamma/profiles",   `https://gamma-api.polymarket.com/profiles?address=${EOA}`);
  await tryFetch("gamma/user",       `https://gamma-api.polymarket.com/user?address=${EOA}`);

  // 2. Data API — positions / activity
  await tryFetch("data/positions",   `https://data-api.polymarket.com/positions?user_address=${EOA}`);
  await tryFetch("data/activity",    `https://data-api.polymarket.com/activity?user_address=${EOA}`);
  await tryFetch("data/proxyWallet", `https://data-api.polymarket.com/proxyWallet?user=${EOA}`);

  // 3. CLOB — bezpośrednio pod EOA
  await tryFetch("clob/balance-sig0", `https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=0&address=${EOA}`);
  await tryFetch("clob/balance-sig2", `https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=2&address=${EOA}`);

  // 4. PolygonScan — ostatnie transfery USDC z/do EOA (bez klucza API, limit rate)
  // USDC na Polygon: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
  await tryFetch("polygonscan/usdc-tx",
    `https://api.polygonscan.com/api?module=account&action=tokentx&address=${EOA}` +
    `&contractaddress=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174&sort=desc&offset=5&page=1`
  );

  // 5. Proxy checker — sprawdź USDC balance EOA on Polygon przez public RPC
  // eth_call do ERC20.balanceOf(EOA)
  await tryFetch("polygon-rpc/usdc-balance",
    "https://polygon-rpc.com"  // będziemy używać fetch z POST
  );

  // Post method dla polygon-rpc
  try {
    const rpcBody = {
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{
        to: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        // balanceOf(address): 0x70a08231 + 000...000 + EOA (bez 0x, padowane do 32 bajtów)
        data: "0x70a08231000000000000000000000000" + EOA.slice(2).toLowerCase(),
      }, "latest"],
    };
    const r = await fetch("https://polygon-rpc.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json() as { result?: string };
    const balHex = d.result ?? "0x0";
    const balUsdc = parseInt(balHex, 16) / 1e6;
    console.log(`\n[polygon-rpc] EOA USDC balance on Polygon: $${balUsdc.toFixed(2)}`);
  } catch (e: unknown) {
    console.log(`[polygon-rpc] error: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log("\n\nJeśli żaden endpoint nie dał proxy address:");
  console.log("→ Idź na polymarket.com → Portfolio → skopiuj adres portfela z URL lub Settings");
  console.log(`→ Albo sprawdź PolygonScan: https://polygonscan.com/address/${EOA}#tokentxns`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
