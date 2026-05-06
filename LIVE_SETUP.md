# KRONOS — Przygotowanie do Live Trading

> Status: GOTOWY DO KONFIGURACJI (nie aktywny)
> Kod jest napisany, wymaga tylko kluczy i zasilenia portfela.

---

## Co musisz zrobić — lista kroków

```
[ ] Krok 1 — Zainstaluj MetaMask
[ ] Krok 2 — Załóż konto Polymarket
[ ] Krok 3 — Zasil portfel USDC
[ ] Krok 4 — Zainstaluj bibliotekę clob-client
[ ] Krok 5 — Skopiuj .env i wpisz klucz prywatny
[ ] Krok 6 — Wygeneruj API credentials
[ ] Krok 7 — Przetestuj DRY RUN
[ ] Krok 8 — Ustaw DRY_RUN=false (dopiero gdy dane to potwierdzą)
```

---

## Krok 1 — MetaMask

1. Pobierz z https://metamask.io (tylko oficjalna strona!)
2. Utwórz nowy portfel
3. **ZAPISZ seed phrase offline** (kartka papieru w sejfie)
4. Dodaj sieć Polygon ręcznie:
   - Network Name: `Polygon`
   - RPC URL: `https://polygon-rpc.com`
   - Chain ID: `137`
   - Currency Symbol: `MATIC`
   - Block Explorer: `https://polygonscan.com`

---

## Krok 2 — Konto Polymarket

1. Wejdź na https://polymarket.com
2. Kliknij "Connect Wallet" → wybierz MetaMask
3. Podpisz wiadomość (bez kosztów)
4. Sprawdź czy Polska nie jest zablokowana (Polymarket ma region restrictions)

---

## Krok 3 — USDC na Polygon

Potrzebujesz USDC (nie ETH, nie MATIC) na sieci Polygon.

**Opcja A — Przez Binance:**
```
Binance → Withdraw → USDC → Sieć: Polygon → Twój adres MetaMask
```

**Opcja B — Bridge z Ethereum:**
```
Kup USDC na Ethereum → użyj bridge.polygon.technology
```

**Minimalna kwota do testów:** $50-100 USDC
**Dla produkcji:** zależy od strategii (przy $1/trade wystarczy $50)

---

## Krok 4 — Biblioteka clob-client

```powershell
cd C:\Users\markowyy\Documents\Polymarket\trader
npm init -y
npm install @polymarket/clob-client ethers dotenv
```

---

## Krok 5 — Plik .env

```powershell
# Skopiuj przykładowy plik
Copy-Item .env.example .env
```

Otwórz `.env` i wpisz klucz prywatny MetaMask:

```
# MetaMask: Menu → Szczegóły konta → Eksportuj klucz prywatny
POLY_PRIVATE_KEY=0x_tutaj_64_znaki_hex

DRY_RUN=true   ← zostaw true dopóki nie jesteś gotowy
```

⚠️ **NIGDY nie pokazuj klucza prywatnego nikomu. Daje pełny dostęp do portfela.**

---

## Krok 6 — Generowanie API credentials

```powershell
cd C:\Users\markowyy\Documents\Polymarket
npx tsx trader/generate-keys.ts
```

Wynik:
```
📍 Adres portfela: 0x1234...abcd
✅ Klucze wygenerowane! Wklej do .env:

POLY_API_KEY=abc123...
POLY_API_SECRET=xyz789...
POLY_API_PASSPHRASE=pass456...
```

Wklej te wartości do `.env`.

---

## Krok 7 — Test DRY RUN

Przy `DRY_RUN=true` bot symuluje zlecenia bez wydawania pieniędzy.

W logu skanera zobaczysz:
```
💰 TRADE SIGNAL:
   Rynek:    ETH 5-Min Up/Down
   Kierunek: YES (UP)
   Cena:     0.405 → payout 2.47x
   Rozmiar:  $1.00
   EV:       +12.3%  |  Kelly: 8.1%
   Expected: +$0.12
   Status:   🧪 DRY RUN — zlecenie NIE zostało wysłane
```

Obserwuj przez kilka dni. Gdy DRY RUN pokazuje zyski i backtest to potwierdza — możesz przejść do kroku 8.

---

## Krok 8 — Live trading (gdy będziesz gotowy)

```env
DRY_RUN=false
```

```powershell
# Restart skanera
npx tsx bot.ts
```

Od teraz każdy sygnał spełniający kryteria złoży prawdziwe zlecenie na Polymarket CLOB.

---

## Limity ryzyka (domyślne)

Konfiguracja w `trader/config.ts`:

| Parametr | Wartość | Znaczenie |
|---|---|---|
| `maxPositionUsd` | $5.00 | Max na 1 trade |
| `maxOpenPositions` | 3 | Max 3 otwarte naraz |
| `minEv` | 8% | Wejdź tylko gdy EV > 8% |
| `minConfidence` | 60% | Wejdź tylko gdy conf > 60% |
| `kellyFraction` | 25% | Używaj ¼ sugerowanego Kelly |
| `maxBankrollPct` | 2% | Max 2% bankrolla na trade |

---

## Jak trader jest zintegrowany z botem

```typescript
// W scanner/bot.ts — fragment kodu do dodania gdy gotowy:

import { execute } from "../trader/trader.js";
import { getPolyPrice } from "./polymarket.js";

// Po wygenerowaniu predykcji, jeśli w oknie wejścia:
if (inWindow && polyPrice && ev > CFG.minEv) {
  const result = await execute({
    market:     market.name,
    direction:  pred.direction,
    confidence: pred.confidence,
    yes_price:  yesPrice,
    ev:         ev,
    kelly:      kelly,
    tokenId:    polyPrice.tokenId,  // do dodania w polymarket.ts
  });

  if (result.status === "executed") {
    console.log(`  ✅ Trade wykonany: $${result.sizeUsd}`);
  }
}
```

---

## Struktura plików tradera

```
trader/
├── config.ts          ← limity ryzyka, credentials
├── trader.ts          ← egzekucja zleceń (DRY/LIVE)
├── positions.ts       ← zarządzanie otwartymi pozycjami
└── generate-keys.ts   ← jednorazowe generowanie kluczy API

.env                   ← TWOJE KLUCZE (nie commituj!)
.env.example           ← szablon
positions.json         ← stan portfela (auto-generowany)
```

---

## Kiedy przejść do live trading?

### Minimalne wymagania przed uruchomieniem

```
✅ Co najmniej 7 dni danych z POLY cenami
✅ Win rate > 53% na BTC/ETH 5-Min przez 7 dni
✅ Pozytywne wyniki na simulate_all.py przez 3 dni z rzędu
✅ DRY RUN przez co najmniej 48h bez błędów
✅ Backtest calibration.py pokazuje model skalibrowany
✅ Rozumiesz że możesz stracić całą zainwestowaną kwotę
```

### Zalecana strategia wejścia

```
Tydzień 1-2:  Tylko obserwacja, zbieranie danych
Tydzień 3-4:  DRY RUN z prawdziwymi sygnałami
Miesiąc 2:    Live z $50 (max $1/trade)
Miesiąc 3+:   Skalowanie jeśli wyniki pozytywne
```

---

⚠️ **WAŻNE OSTRZEŻENIA**

> - Handel na Polymarket to spekulacja, możesz stracić całość
> - Klucz prywatny = dostęp do portfela — chroń go jak hasło do banku
> - Polymarket może mieć region restrictions — sprawdź regulamin
> - Bot nie gwarantuje zysku — backtest ≠ live performance
> - Zacznij od kwoty której utrata Ci nie zaszkodzi
