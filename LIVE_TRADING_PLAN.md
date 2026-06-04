# KRONOS — Plan Przejścia na Real Trading

> Wersja: 1.0 | Data: 2026-05-12 | Status: Faza 1 w toku
> Autor: analiza na podstawie 1188 trades, 16 dni danych

---

## Stan startowy (2026-05-12)

### Wyniki backtestów (podstawa do decyzji)

| Rynek | Trades | WR | PNL ($1/trade) | DD |
|---|---|---|---|---|
| **BTC 15M** (z filtrem godzin) | **138** | **60.1%** | **+$38.79** | **3.9%** |
| ETH 15M | 166 | 51.2% | +$14.47 | 7.8% |
| BTC 5M | 424 | 49.3% | +$12.85 | 13.4% |
| ETH 5M | 438 | 47.3% | +$1.40 | 24.3% |

### Istotność statystyczna BTC 15M

```
Break-even WR przy payout 2.13x = 46.9%
Obserwowane WR = 60.1%  (138 trades)
Test z: (0.601 - 0.469) / sqrt(0.469 × 0.531 / 138) = 3.11
p-value = 0.001  →  edge istotny statystycznie ✅

ALE: filtr godzinowy był dopasowany do tych samych danych.
Potrzeba out-of-sample walidacji (Faza 1).
```

---

## FAZA 1 — Walidacja Out-of-Sample

> **Czas trwania:** ~2 tygodnie (2026-05-12 → 2026-05-26)
> **Co robimy:** Bot zbiera nowe dane których jeszcze nie widzieliśmy. Oceniamy czy edge się utrzymuje.

### Warunki do spełnienia (WSZYSTKIE)

```
[ ] BTC 15M: min. 200 nowych trades (po 2026-05-12)
[ ] BTC 15M WR na nowych danych: > 55%
[ ] BTC 15M Rolling WR (ostatnie 50 trades): > 53%
[ ] Maksymalny drawdown w tym oknie: < 12%
[ ] Worst losing streak: < 7 z rzędu
[ ] Bot uptime: > 95% (max 1 restart/dobę)
```

### Jak sprawdzić po 2 tygodniach

```powershell
# Pełny raport
python -X utf8 backtest/simulate_all.py

# Tylko nowe dane (od dziś)
python -X utf8 -c "
import sqlite3
db = sqlite3.connect('kronos.db')
c = db.cursor()
c.execute('''
    SELECT COUNT(*), SUM(correct), ROUND(SUM(correct)*100.0/COUNT(*),1)
    FROM edges
    WHERE market = 'BTC 15-Min Up/Down'
      AND resolved = 1
      AND ts >= '2026-05-12'
      AND ABS(yes_price - 0.51) > 0.005
      AND yes_price BETWEEN 0.10 AND 0.90
''')
n, wins, wr = c.fetchone()
print(f'Nowe trades: {n}, WR: {wr}%')
"
```

### Decyzja po Fazie 1

```
WR nowych danych > 55%  → PRZEJDŹ DO FAZY 2
WR nowych danych 50-55% → CZEKAJ kolejne 2 tygodnie, nie wchodź
WR nowych danych < 50%  → STOP, edge zniknął, wróć do kalibracji
```

---

## FAZA 2 — Przygotowanie Techniczne

> **Czas trwania:** ~1 tydzień po pozytywnej Fazie 1
> **Co robimy:** Wszystkie techniczne przygotowania przed wpłatą pieniędzy.

### Checklist — infrastruktura

```
[ ] 1. Polymarket dostępny z Twojej lokalizacji
        → Wejdź na polymarket.com
        → Sprawdź czy możesz się zarejestrować (Polska = szara strefa)
        → Jeśli blokada → skonfiguruj VPN (nie USA, np. UK/DE)

[ ] 2. MetaMask + USDC na Polygon
        → Zainstaluj MetaMask (tylko metamask.io)
        → ZAPISZ seed phrase offline na papierze
        → Kup $100 USDC, wyślij na Polygon przez Binance
        → Sieć: Polygon | Chain ID: 137 | Symbol: MATIC

[ ] 3. Wygeneruj API klucze Polymarket
        → npm install @polymarket/clob-client ethers dotenv  (w ./trader/)
        → Skopiuj .env.example → .env, wpisz POLY_PRIVATE_KEY
        → npx tsx trader/generate-keys.ts
        → Wklej POLY_API_KEY / SECRET / PASSPHRASE do .env

[ ] 4. Test DRY RUN (48h)
        → DRY_RUN=true w .env (domyślnie)
        → Uruchom bota normalnie
        → Sprawdź w logach: "DRY RUN — zlecenie NIE zostało wysłane"
        → Policz ile sygnałów BTC 15M przechodzi filtr dziennie
        → Oczekiwane: ~8-12 sygnałów/dobę na BTC 15M

[ ] 5. Zmierz realny spread na Polymarket
        → Wejdź na aktywny rynek BTC 15M Up/Down na polymarket.com
        → Sprawdź Orderbook: różnica bid-ask
        → Akceptowalny spread: < 5pp (np. bid 0.43, ask 0.47 = 4pp spread)
        → Jeśli spread > 6pp → edge może być zjedzony przez koszty

[ ] 6. Alert system (krytyczne)
        → Bot musi Ci wysłać powiadomienie gdy padnie
        → Opcja prosta: dodaj webhook Telegram/email do bot.ts
        → Bez alertów nie wiesz że zbierasz złe dane przez całą noc
```

### Analiza kosztów transakcyjnych

```
Przykład: kupujesz YES po mid 0.45 (payout 2.22x)

Realny fill przy spread 4pp:
  Mid: 0.45
  Bid: 0.43  ← płacisz tyle (rynek bierze ask od Ciebie)
  Efektywny payout: 1/0.43 = 2.33x  (lepsza niż mid — kupujesz YES taniej)

Przykład: kupujesz YES po mid 0.55 (payout 1.82x)
  Bid: 0.53
  Efektywny payout: 1/0.53 = 1.89x

Gaz Polygon: ~$0.001-0.01 per transakcja → pomijalne
WNIOSEK: spread 4pp przy naszych payoutach (2.13x avg) jest akceptowalny.
```

---

## FAZA 3 — Live Trading (Minimum Viable)

> **Kiedy wejść:** Po pozytywnych Fazach 1 i 2
> **Kapitał startowy:** $50-100 USDC
> **Rynek:** TYLKO BTC 15-Min Up/Down

### Parametry ryzyka — start

```
DRY_RUN=false                    ← jedyna zmiana w .env

W trader/config.ts:
  maxPositionUsd:    1.0         ← $1 per trade (nie więcej!)
  maxOpenPositions:  2           ← max 2 otwarte jednocześnie
  minEv:             0.08        ← wejdź tylko gdy EV > 8%
  minConfidence:     0.55        ← Platt-calibrated confidence
  kellyFraction:     0.10        ← 10% Kelly (bardzo konserwatywnie)
  maxBankrollPct:    0.02        ← max 2% bankrolla na trade
```

### Daily stop-loss — OBOWIĄZKOWY

```
Ustaw regułę: jeśli stracisz $8 w jednym dniu → STOP na dziś.

Implementacja w głowie (lub dodaj do kodu):
  - Sprawdzaj co rano: ile strat wczoraj?
  - 8 strat pod rząd = $8 strata = zatrzymaj bota do jutra
  - Nie próbuj "odrabiać" tego samego dnia
```

### Plan skalowania

```
Tydzień 1:  $1/trade
            → Obserwuj fill rate, spread, czy zlecenia się realizują
            → Cel: potwierdzić że infrastruktura działa

Tydzień 2-4: jeśli WR live > 54% i brak problemów technicznych
            → Podnieś do $2/trade

Miesiąc 2:  jeśli WR live > 56% przez 4 tygodnie
            → Podnieś do $5/trade

Miesiąc 3+: jeśli WR live > 56% stabilnie
            → Przejdź na Kelly sizing ($1-10/trade dynamicznie)
            → Rozważ dodanie ETH 15M jeśli też pokazuje edge
```

---

## FAZA 4 — Monitoring Live (ciągłe)

### Raport poranny (codziennie, 2 minuty)

```powershell
# Stan całości
python -X utf8 backtest/simulate_all.py

# Sprawdź ostatnie 7 dni live
python -X utf8 -c "
import sqlite3
db = sqlite3.connect('kronos.db')
c = db.cursor()
c.execute('''
    SELECT COUNT(*), SUM(correct), ROUND(SUM(correct)*100.0/COUNT(*),1)
    FROM edges
    WHERE market = 'BTC 15-Min Up/Down'
      AND resolved=1 AND ts >= date('now','-7 days')
      AND ABS(yes_price-0.51)>0.005 AND yes_price BETWEEN 0.10 AND 0.90
''')
n, wins, wr = c.fetchone()
print(f'7d: {n} trades, {wr}% WR')
"
```

### Sygnały zatrzymania (STOP natychmiast)

| Co widzisz | Akcja |
|---|---|
| Rolling WR (50 trades) < 50% przez 3 cykle | Zatrzymaj bota, wróć do kalibracji |
| Drawdown > 15% od szczytu | Zatrzymaj, sprawdź czy Polymarket coś zmienił |
| 7+ strat z rzędu | Zatrzymaj na 24h, sprawdź logi |
| Spread BTC 15M nagle > 8pp | Zatrzymaj — płynność się pogorszyła |
| Bot crashuje > 1x dziennie | Napraw zanim puszczasz live |
| Polymarket zmienia format API | Sprawdź czy tokeny się poprawnie mapują |

### Rekalibracja — kiedy

```
Co 2 tygodnie: python -X utf8 research/recalibrate_confidence.py
               → Zaktualizuj PLATT w bot.ts jeśli Brier Score wzrósł > 0.28

Co miesiąc:    python -X utf8 research/calibrate_lag.py
               → Sprawdź czy sensitivity/threshold jest aktualny

Co miesiąc:    Sprawdź godzinowy WR BTC 15M
               → Aktualizuj skipHoursUtc jeśli nowe dead zones
```

---

## Decydujące pytania przed live

Odpowiedz uczciwie na każde:

```
1. Czy strata całego kapitału ($50-100) nie zaszkodzi mi finansowo?
   TAK → możesz wejść | NIE → nie wchodź jeszcze

2. Czy mogę codziennie przez 5 minut sprawdzać wyniki?
   TAK → możesz wejść | NIE → nie wchodź (bot może się zepsuć w nocy)

3. Czy Polymarket jest dostępny z mojej lokalizacji?
   TAK → możesz wejść | NIE → rozwiąż VPN lub poczekaj

4. Czy bot działał 5+ dni bez restartu?
   TAK → możesz wejść | NIE → poczekaj na stabilność

5. Czy WR nowych danych (Faza 1) przekroczył 55%?
   TAK → możesz wejść | NIE → za wcześnie
```

---

## Podsumowanie — Harmonogram

```
2026-05-12  START Fazy 1 (out-of-sample zbieranie)
2026-05-26  Ocena Fazy 1 → decyzja: wchodzę / czekam
2026-06-02  START Fazy 2 (jeśli Faza 1 OK)
2026-06-09  START Fazy 3: live $1/trade, tylko BTC 15M
2026-07-09  Ocena pierwszego miesiąca live
```

---

## Ważne ostrzeżenia

> - **Backtest ≠ live performance** — spread, timing, API errors, flash crashes
> - **Edge może zniknąć** — rynki predykcyjne adaptują się, jak gracze zobaczą wzorzec
> - **Polymarket Region Restrictions** — sprawdź regulamin, Polska nie jest oficjalnie obsługiwana
> - **Klucz prywatny = portfel** — nie commituj .env do git, nie pokazuj nikomu
> - **$50-100 to eksperyment badawczy**, nie inwestycja. Zacznij od kwoty którą możesz stracić w całości

---

*KRONOS TERMINAL v3.0 | Wygenerowano 2026-05-12*
