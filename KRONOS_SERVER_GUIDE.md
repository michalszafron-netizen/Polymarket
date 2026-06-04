# KRONOS — Przewodnik Serwera (Polis)

## Dane serwera

| | |
|---|---|
| **IP** | 185.28.100.191 |
| **Nazwa** | polis |
| **Provider** | Forpsi VPS Mini+ |
| **Lokalizacja** | Czechy (brak geoblokady Polymarket) |
| **System** | Ubuntu 24.04 LTS |
| **Login** | PuTTY → root@185.28.100.191 |

---

## Architektura

```
Serwer (polis)                     Lokalny PC
─────────────────────────────      ─────────────────────
PM2: kronos-bot (DRY_RUN=false)    PM2 lub npx tsx: bot (DRY_RUN=true)
PM2: sidecar (uvicorn :8000)       Dashboard: localhost:3000
SQLite: /root/kronos/kronos.db     SQLite: lokalna baza
Portfel: nowy MetaMask (serwer)    Portfel: lokalny (bez środków)
```

---

## PM2 — komendy zarządzania

### Sprawdź status wszystkich procesów
```bash
pm2 status
```

### Podgląd logów na żywo
```bash
pm2 logs kronos-bot --lines 50   # logi bota (trading)
pm2 logs sidecar --lines 30      # logi sidecar (ML/GBM)
```
> Ctrl+C wyłącza tylko podgląd — procesy działają nadal.

### Restart
```bash
pm2 restart kronos-bot           # restart tylko bota
pm2 restart sidecar              # restart tylko sidecar
pm2 restart all                  # restart wszystkiego
```

### Stop / Start
```bash
pm2 stop kronos-bot
pm2 start kronos-bot
pm2 stop all
```

### Autostart po reboocie (uruchom raz)
```bash
pm2 save && pm2 startup
```
Skopiuj i wklej komendę którą wypisze `pm2 startup`.

---

## Sidecar — uvicorn (port 8000)

Sidecar to Python FastAPI — model GBM do predykcji.

### Sprawdź czy działa
```bash
curl http://localhost:8000/health
```
Poprawna odpowiedź: `{"status":"ok","model":"monte-carlo-gbm","model_ready":true}`

### Jeśli sidecar jest offline — uruchom ręcznie (test)
```bash
cd /root/kronos/sidecar && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000
```

### PM2 uruchamia sidecar przez wrapper
```bash
cat /root/start-sidecar.sh   # pokaż skrypt startowy
pm2 restart sidecar          # restart przez PM2
```

---

## Node.js (nvm)

Serwer używa Node.js 20 przez nvm. Po nowym loginie przez SSH:
```bash
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"
node --version   # powinno pokazać v20.x.x
```
> PM2 i tsx działają bez aktywacji nvm — to tylko dla ręcznych komend.

---

## Baza danych

```bash
sqlite3 /root/kronos/kronos.db ".tables"          # lista tabel
sqlite3 /root/kronos/kronos.db "SELECT COUNT(*) FROM edges;"
sqlite3 /root/kronos/kronos.db "SELECT * FROM edges WHERE traded=1 ORDER BY ts DESC LIMIT 5;"
```

---

## Pliki konfiguracyjne

| Plik | Zawartość |
|---|---|
| `/root/kronos/.env` | Klucze API, DRY_RUN=false — NIGDY nie commituj do git |
| `/root/start-sidecar.sh` | Wrapper startowy dla sidecar |
| `/root/kronos/kronos.db` | Baza SQLite z danymi live |

---

## Scenariusze awaryjne

### Bot crashuje w pętli
```bash
pm2 logs kronos-bot --lines 50   # znajdź błąd
pm2 restart kronos-bot           # restart
```

### Sidecar nie odpowiada
```bash
pm2 restart sidecar
sleep 20
curl http://localhost:8000/health
```

### Wszystko padło — pełny reset
```bash
pm2 kill
export NVM_DIR="$HOME/.nvm" && \. "$NVM_DIR/nvm.sh"
pm2 start /root/start-sidecar.sh --name sidecar --interpreter bash
pm2 start ~/.nvm/versions/node/v20.20.2/bin/tsx --name kronos-bot -- scanner/bot.ts
pm2 save
```

### Sprawdź czy port 8000 nasłuchuje
```bash
ss -tlnp | grep 8000
```

---

## Portfel (serwer)

- **Sieć**: Polygon (MATIC)
- **Token**: USDC (nie USDT)
- **Depozyt gazu**: ~0.5 MATIC (jednorazowo, na opłaty za deposit)
- **Wypłata**: przez MetaMask — klucz prywatny = pełna kontrola
- **KYC**: brak (non-custodial, smart contract)

### Doładowanie
1. Wyślij USDC na Polygon na adres nowego portfela MetaMask
2. Wyślij ~0.5 MATIC na ten sam adres (na gaz depozytu)
3. Wejdź na polymarket.com, połącz portfel, zdeponuj USDC

---

## Polymarket CLOB V2 — Integracja (krytyczne!)

> Polymarket wykonał migrację giełdy **28 kwietnia 2026**. Stary klient (`@polymarket/clob-client`) jest zarchiwizowany i NIE DZIAŁA. Poniżej wszystko czego potrzebujesz żeby nie stracić dwóch dni debugowania.

### Co się zmieniło w V2

| Element | Stary system (V1) | Nowy system (V2) |
|---|---|---|
| Biblioteka | `@polymarket/clob-client` | `@polymarket/clob-client-v2` + `viem` |
| Adres giełdy | `0x4bFb41d5B3570...` | `0xE111180000d266...` |
| Nazwa domeny EIP-712 | `"Polymarket CTF Exchange"` | `"CtfExchange"` |
| Typ podpisu | POLY_PROXY (2) | POLY_1271 (3) — ERC-1271 |
| Maker | proxy wallet | deposit wallet (ten sam adres co w UI) |
| Pola payload | brak `taker`, `expiration`, `postOnly` | wymagane `taker`, `expiration: "0"`, `postOnly: false` |
| Minimalna wielkość | dowolna | **5 tokenów** (nie USDC!) |

### Jak działa podpisywanie (POLY_1271)

W V2 Polymarket używa **ERC-1271** — deposit wallet to smart kontrakt który weryfikuje podpisy. Format podpisu jest złożony (composite EIP-7702). **Nie implementuj tego ręcznie** — użyj oficjalnej biblioteki.

### Prawidłowa konfiguracja

```typescript
import { ClobClient, Chain, Side, OrderType, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(POLY_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account,
  transport: http("https://polygon-rpc.com"),  // wymagany URL!
});

const client = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: Chain.POLYGON,
  signer: walletClient,
  signatureType: SignatureTypeV2.POLY_1271,
  funderAddress: POLY_PROXY_ADDRESS,   // deposit wallet z UI Polymarket
  creds: { key: POLY_API_KEY, secret: POLY_API_SECRET, passphrase: POLY_API_PASSPHRASE },
});

// Złóż zlecenie
const resp = await client.createAndPostOrder(
  { tokenID: tokenId, price, side: Side.BUY, size: Math.max(size, 5) },
  { tickSize: "0.01", negRisk: false },
  OrderType.GTC,
);
```

### Czym jest POLY_PROXY_ADDRESS?

To adres **deposit wallet** widoczny w UI Polymarket po zalogowaniu (adres `0xbbe...` w .env). To **NIE** jest Twój EOA MetaMask — to pośredni smart kontrakt który Polymarket przypisuje do Twojego konta.

### Instalacja pakietów

Pakiety muszą być zainstalowane w **katalogu głównym** (`/root/kronos/`), bo `trader/trader.ts` nie widzi pakietów z `scanner/node_modules/`:

```bash
cd /root/kronos && npm install @polymarket/clob-client-v2 viem
```

### Błędy i co oznaczają

| Błąd | Przyczyna | Rozwiązanie |
|---|---|---|
| `Invalid order payload` | Brakuje pól w JSON (`taker`, `expiration`, `postOnly`, `deferExec`) lub `salt` jako string | Użyj clob-client-v2 (obsługuje automatycznie) |
| `order_version_mismatch` | Zła nazwa domeny EIP-712 (`"Polymarket CTF Exchange"` zamiast `"CtfExchange"`) lub zły adres giełdy | Użyj clob-client-v2 |
| `maker address not allowed, please use the deposit wallet flow` | Zły signatureType lub stary proxy wallet jako maker | signatureType=POLY_1271, maker=deposit wallet |
| `Size (X) lower than the minimum: 5` | Mniej niż 5 tokenów w zleceniu | `Math.max(size, 5)` w kodzie |
| `Cannot find package 'viem'` | Pakiety zainstalowane w `scanner/` zamiast w katalogu głównym | `cd /root/kronos && npm install viem` |
| `No URL was provided to the Transport` | Brak URL w `http()` viem | `http("https://polygon-rpc.com")` |

### Pierwsze udane zlecenie

Data: **2026-06-04 23:00 UTC**
Order ID: `0x93739e4a90b147ee67dc80583c718901c0f701a6a2877c5b0b0ffef082077422`
Rynek: BTC 5M UP, cena 0.405, 5 tokenów

---

## Monitoring z dashboardu lokalnego

Dashboard pod `localhost:3000` pokazuje teraz:
- **STATUS SERWERA (POLIS)** — czy sidecar serwera odpowiada na :8000
- Dane dry-run z lokalnej bazy (do porównania)

Dane live z serwera (transakcje, PnL) będą dostępne po rozszerzeniu sidecar o endpoint `/trades`.
