# KRONOS TERMINAL — Dokumentacja Systemu

> Wersja: 2.0 | Data: 2026-05-10 | Status: Live (Research Mode)

---

## 1. Co to jest

KRONOS to system badawczy do wykrywania i analizowania statystycznych przewag (edge) na rynkach predykcyjnych Polymarket. Łączy dane cenowe z Bybit z modelem AI (Amazon Chronos) aby generować predykcje kierunku ceny BTC i ETH, które następnie konfrontuje z realnymi kursami z Polymarket CLOB.

**Nie jest to bot tradingowy** — system nie wykonuje żadnych zleceń automatycznie. Generuje sygnały i mierzy ich historyczną trafność.

---

## 2. Architektura systemu

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           KRONOS TERMINAL                                   │
├──────────────┬──────────────────────┬───────────────────────┬───────────────┤
│   SCANNER    │       SIDECAR        │      DASHBOARD        │  LAG MONITOR  │
│  (Node.js)   │      (Python)        │      (Next.js)        │  (Node.js)    │
│              │                      │                       │               │
│ Co 5 minut:  │  POST /predict       │  localhost:3000       │  Co 5 sekund: │
│ 1. Bybit API │  ──────────────────► │  - PNL Chart          │  1. Binance WS│
│ 2. Chronos   │  Amazon Chronos T5   │  - Signal Radar       │  2. Poly CLOB │
│ 3. Poly CLOB │  200M parametrów     │  - Trade Ledger       │  3. Fair model│
│ 4. SQLite    │  CPU inference       │  - System Status      │  4. Lag log   │
│              │  ~1.3s/predykcja     │  - Prediction Console │  5. Sygnał DC │
│              │                      │  - Lag Monitor viz    │               │
└──────────────┴──────────────────────┴───────────────────────┴───────────────┘
                               │
                         kronos.db
                        (SQLite WAL)
```

### Komponenty

| Komponent | Technologia | Port | Rola |
|---|---|---|---|
| Scanner Bot | TypeScript + Node.js | — | Orkiestracja, zapis danych |
| Sidecar | Python + FastAPI | 8000 | Inference AI (Chronos) |
| Dashboard | Next.js 15 + React | 3000 | Wizualizacja |
| Lag Monitor | TypeScript + Node.js | — | Spot ↔ Poly lag detection |
| Binance WS | WebSocket | — | Feed cen BTC/ETH 1s |
| Baza danych | SQLite (WAL mode) | — | Persystencja |

---

## 3. Jak działa — krok po kroku

### Cykl skanowania (co 5 minut)

```
1. SYNCHRONIZACJA
   Bot czeka na granicę 5-minutową zegara UTC (np. 16:45:00)
   Odpala 2 sekundy wcześniej → pierwsze sekundy okna Polymarket

2. RESOLUCJA poprzednich predykcji
   Porównuje anchor_price z aktualną ceną Bybit
   Oznacza edges jako correct=1/0, zapisuje PNL

3. SCAN każdego rynku:
   a) Pobierz 50 świec OHLCV z Bybit (BTC lub ETH, 5M lub 15M)
   b) Sprawdź timing: jesteśmy w pierwszej połowie okna?
      - 5-Min: pierwsze 150s z 300s → TAK → dalej
      - 15-Min: pierwsze 270s z 900s → TAK → dalej
      - Inne → SKIP (cena Polymarket byłaby "zatruta" ruchem)
   c) Wyślij świece do Sidecar → Chronos generuje 100 ścieżek przyszłości
   d) Pobierz cenę YES z Polymarket CLOB (bez auth, publiczne API)
   e) Oblicz EV i Kelly dla właściwego tokenu (YES jeśli UP, NO jeśli DOWN)
   f) **Double Confirmation**: sprawdź czy Lag Monitor daje ten sam sygnał
   g) Zapisz edge do SQLite (RAW confidence, nie skalibrowany)

4. LOG do konsoli:
   ✅ 🤖 BTC 5M → DOWN 93%→52% cal | EV 59% | K 83% | 1308ms [POLY:0.415 [+8s]] 🟢DC
```

### Formuły matematyczne

```
bet_price = yes_price          (gdy direction = UP)
bet_price = 1 - yes_price      (gdy direction = DOWN)

EV    = confidence × (1 / bet_price) - 1
Kelly = (b × p - q) / b
        gdzie b = payout - 1, p = confidence, q = 1 - confidence

correct = 1  gdy direction=UP  i resolve_price > anchor_price
correct = 1  gdy direction=DOWN i resolve_price < anchor_price
```

### Platt Scaling (rekalibracja confidence)

Chronos jest overconfident — mówi 95% a trafia ~50%. Platt scaling mapuje raw confidence na skalibrowane p-stwo:

```
calibrated = sigmoid(A × rawConfidence + B)

BTC 5M:  A =  1.0997, B = -1.1046
ETH 5M:  A = -3.1659, B =  2.8221
BTC 15M: A = -2.4435, B =  2.2109
ETH 15M: A = -0.0433, B = -0.1152
```

Brier Score przed: ~0.44 → po: ~0.25 ✅ (dobrze skalibrowany)

---

## 4. Lag Monitor — Spot ↔ Polymarket Lag Detection

### Co to jest

Lag Monitor to podsystem działający równolegle do głównego skanera. Co 5 sekund:
1. Pobiera snapshot ceny spot z Binance WebSocket (BTCUSDT, ETHUSDT)
2. Pobiera midpoint Polymarket CLOB dla aktualnego okna
3. Liczy "fair YES price" wg modelu wrażliwości na zmianę spot
4. Loguje lukę (lag_pct) do tabeli `lag_log`
5. Emituje sygnał `BUY_YES` / `BUY_NO` gdy luka > threshold

### Model fair price

```
fair_yes = clamp(α + spot_change_pct × sensitivity, 0.02, 0.98)
lag_pct  = (fair_yes - poly_yes) × 100  (w punktach procentowych)
```

### Kalibracja v2 (2026-05-10)

Wykonana na ~20k próbkach z filtrem okna (pierwsza połowa). Regresja liniowa `poly_yes ~ spot_change_pct`:

| Rynek | N | α (intercept) | Sensitivity (pp/1%) | R² | Threshold (95p) |
|---|---|---|---|---|---|
| BTC 5M | 4998 | 0.496 | 598 | 0.675 | 21.74pp |
| ETH 5M | 4730 | 0.497 | 553 | 0.756 | 19.17pp |
| BTC 15M | 5504 | 0.505 | 331 | 0.793 | 14.23pp |
| ETH 15M | 5431 | 0.503 | 286 | 0.796 | 14.37pp |
| **Globalny threshold** | | | | | **17.4pp** |

### Edge detection

```
|lag_pct| > 17.4pp  → sygnał (BUY_YES gdy poly za nisko, BUY_NO gdy poly za wysoko)
+ filtr okna: 5M < 150s, 15M < 270s (tylko pierwsza połowa)
```

### Double Confirmation

Lag Monitor udostępnia funkcję `getLatestLagSignal(market)` która zwraca ostatni sygnał (ważny przez 30s). Bot używa jej do strategii **Double Confirmation**:

- Chronos UP + Lag BUY_YES → 🟢DC (zgodne)
- Chronos DOWN + Lag BUY_NO → 🟢DC (zgodne)
- Sprzeczne → 🔴DC
- Brak sygnału lag → ⏳

---

## 5. Model AI — Amazon Chronos T5-base

### Czym jest

- Open-source model do prognozowania szeregów czasowych
- Opublikowany przez Amazon Research (2024)
- Licencja: Apache 2.0 — bezpłatny, lokalny, bez API key
- Rozmiar: 806 MB na dysku
- Parametry: 200 milionów

### Jak działa

Chronos tokenizuje wartości numeryczne do 4096 dyskretnych kubełków i przetwarza je przez architekturę T5 (transformer). Generuje N niezależnych próbek przyszłych wartości — liczymy ile kończy powyżej/poniżej ceny obecnej.

```
[cena_1, cena_2, ..., cena_50] → Chronos → 100 próbek → prob_up = 53/100
```

### Tryb fallback

Jeśli Chronos nie załaduje się → GBM Monte Carlo (geometryczny ruch Browna). Identyczna logika co prototyp poly-oracle.html.

```powershell
# Ręczne przełączenie na GBM:
$env:INFERENCE_MODE = "gbm"
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## 6. Integracja Polymarket

### Co pobieramy

```
Gamma API:  https://gamma-api.polymarket.com/events?slug=btc-updown-5m-{timestamp}
CLOB API:   https://clob.polymarket.com/midpoint?token_id={YES_token_id}

Zwraca: { "mid": "0.415" }  → cena YES tokenu
```

### Mapowanie rynków

| Rynek wewnętrzny | Slug Polymarket | Interwał |
|---|---|---|
| BTC 5-Min Up/Down | btc-updown-5m-{ts} | 5 min |
| ETH 5-Min Up/Down | eth-updown-5m-{ts} | 5 min |
| BTC 15-Min Up/Down | btc-updown-15m-{ts} | 15 min |
| ETH 15-Min Up/Down | eth-updown-15m-{ts} | 15 min |

### Filtrowanie danych w backtestach

```sql
-- Tylko prawdziwe ceny (nie symulowane 0.51)
ABS(yes_price - 0.51) > 0.005

-- Tylko ceny w rozsądnym zakresie (nie z końca okna)
yes_price BETWEEN 0.10 AND 0.90
```

---

## 7. Wyniki po 48h danych (2026-04-26 → 2026-05-10)

### Stan bazy

| Tabela | Liczba rekordów |
|---|---|
| edges | 5752 total, 5744 resolved |
| lag_log | 132736 próbek |
| Poprawne edges | 2864 (49.9%) |

### Chronos AI — surowa trafność

Chronos samodzielnie ma **49.9% WR** = random. To potwierdza, że zero-shot Chronos na danych krypto nie ma przewagi nad rzutem monetą.

### Double Confirmation — przełom

Korelacja sygnałów Chronos vs Lag Monitor (19-16-553 trades):

| Sytuacja | Trades | Win Rate |
|---|---|---|
| **Zgodne** (Chronos + Lag) | **19** | **68.4%** ✅ |
| Sprzeczne | 16 | 25.0% |
| Brak sygnału lag | 553 | 48.1% |

**Wniosek**: Gdy Chronos i Lag Monitor są zgodne → 68.4% WR. Rekomendacja: wchodź TYLKO gdy oba sygnały zgodne.

### Platt Scaling — kalibracja confidence

| Rynek | N | Brier przed | Brier po | Poprawa |
|---|---|---|---|---|
| BTC 5M | 199 | 0.4485 | 0.2493 | ✅ +0.1992 |
| ETH 5M | 211 | 0.4452 | 0.2470 | ✅ +0.1982 |
| BTC 15M | 87 | 0.4175 | 0.2471 | ✅ +0.1704 |
| ETH 15M | 91 | 0.4439 | 0.2485 | ✅ +0.1954 |

Brier Score ~0.25 = dobrze skalibrowany (0.25 = idealna kalibracja).

---

## 8. Wady systemu

### Krytyczne
- **Brak egzekucji** — system nie składa zleceń, wszystko manualne
- **Brak zarządzania ryzykiem** — Kelly criterion wymaga kalibracji
- **Chronos nie był fine-tunowany** na krypto ani Polymarket — zero-shot
- **Chronos ma 49.9% WR = random** bez Double Confirmation
- **CPU inference** — 1.3s/predykcja, przy GPU byłoby 50ms

### Istotne
- **Double Confirmation bazuje na małej próbce** — tylko 19 zgodnych trades
- **Lag Monitor wymaga ciągłego Binance WS** — ryzyko rozłączenia
- **Brak Chainlink oracle** — rozwiązujemy edges po cenie Bybit, Polymarket używa Chainlink (drobne rozbieżności)
- **Brak spread/slippage** — backtest zakłada idealne wejście po mid-price
- **Brak position limits** — Kelly może sugerować duże pozycje na małej próbce
- **Model bias** — Chronos ma 54% YES / 46% NO bias (widoczny w Model Bias)

### Mniejsze
- Brak obsługi błędów połączenia Polymarket (fallback na 0.51)
- NEXT RESOLVE timer zakłada że rynki otwierają się co okrągłe 5 min UTC (co jest prawdą, ale może nie zawsze)
- Dashboard nie pokazuje rzeczywistego P&L w czasie rzeczywistym (symulacja)

---

## 9. Zalety systemu

- **Lokalne AI** — zero kosztów inference, Chronos działa na własnym CPU/GPU
- **Prawdziwe ceny Polymarket** — CLOB midpoint zamiast symulowanych 0.51
- **Synchronizacja czasowa** — scanner startuje 2s przed otwarciem okna
- **Filtr okna** — odrzuca sygnały z połowy/końca okna (zatruty pricing)
- **Double Confirmation** — 68.4% WR gdy Chronos + Lag zgodne
- **Lag Monitor z kalibracją v2** — R² > 0.68, threshold 17.4pp
- **Platt scaling** — Brier Score 0.25 (dobrze skalibrowany)
- **Persystentna baza** — SQLite WAL, dane nie giną przy restarcie
- **Pełny pipeline backtestowy** — simulate_all.py, simple.py, kelly.py, diagnose.py
- **Dashboard live** — PNL chart, Lag Monitor viz, system status, POLY LIVE badge

---

## 10. Jak uruchomić

```powershell
# Uruchom wszystko jednym plikiem:
start.bat

# Lub ręcznie (3 okna PowerShell):

# Okno 1 — Sidecar AI
cd C:\Users\markowyy\Documents\Polymarket\sidecar
python -m uvicorn main:app --host 0.0.0.0 --port 8000

# Okno 2 — Scanner (bot + lag monitor + binance ws)
cd C:\Users\markowyy\Documents\Polymarket\scanner
npx tsx bot.ts

# Okno 3 — Dashboard
cd C:\Users\markowyy\Documents\Polymarket\dashboard
pnpm dev

# Przełączenie na GBM (awaryjnie):
$env:INFERENCE_MODE = "gbm"
```

---

## 11. Narzędzia analityczne

```powershell
# Pełny raport wszystkich rynków (tylko POLY live)
python backtest/simulate_all.py

# Surowa dokładność predykcji
python backtest/simple.py --market 'BTC 5-Min Up/Down'

# Kelly backtest ze strategiami
python backtest/kelly.py --bankroll 10000 --gate 0.65 --save

# Kalibracja modelu (czy confidence = faktyczna trafność)
python research/calibration.py

# Diagnostyka cen (sprawdź czy yes_price są sensowne)
python backtest/diagnose.py

# Kalibracja Lag Monitora (znajdź sensitivity i threshold)
python research/calibrate_lag.py

# Platt Scaling (rekalibracja Chronos confidence)
python research/recalibrate_confidence.py

# Korelacja sygnałów Chronos vs Lag Monitor
python research/correlate_signals.py

# Podgląd bazy danych
python research/db_status.py
```

---

## 12. Możliwości testowania

### Testy statystyczne (po zebraniu danych)

```
Po 24h:   ~300 POLY trades → pierwsza miarodajna analiza
Po 72h:   ~900 POLY trades → stabilna ocena edge per rynek
Po 1 tyg: ~2000 POLY trades → można wyciągać wnioski
```

### Co testować

1. **Trafność per rynek** — który rynek ma prawdziwy edge? (ETH 5M wygląda najlepiej)
2. **Trafność per bucket confidence** — czy wyższy confidence = wyższa trafność?
3. **Kalibracja Chronosa** — `python research/calibration.py`
4. **Porównanie rano vs wieczór** — czy w różnych godzinach edge się zmienia?
5. **BTC vs ETH** — który token jest lepiej przewidywalny?
6. **5-Min vs 15-Min** — który horyzont lepiej trafia?
7. **Double Confirmation** — czy 68.4% WR utrzymuje się na większej próbce?

---

## 13. Możliwości ulepszenia

### Krótkoterminowe (bez dużych zmian)

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Zwiększyć n_samples 100→500 po zwolnieniu miejsca na GPU | ⭐ | Dokładniejsze prob |
| Dodać filtr confidence gate w scannerze (zapisuj tylko >60%) | ⭐ | Czystsze dane |
| Fine-tuning Chronosa na historycznych danych BTC/ETH | ⭐⭐⭐ | +5-10% accuracy |
| Dodać więcej rynków (SOL, MATIC) | ⭐ | Więcej okazji |
| Automatyczna rekalibracja Platt scaling co N dni | ⭐ | Utrzymanie kalibracji |
| Dynamiczny threshold lag monitora (zamiast stałego 17.4pp) | ⭐⭐ | Lepsze sygnały |

### Średnioterminowe

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Egzekucja przez Polymarket API (składanie zleceń) | ⭐⭐⭐ | Przejście do live trading |
| Chainlink oracle jako resolve source (zamiast Bybit) | ⭐⭐ | Dokładniejszy resolve |
| Dodanie on-chain data (funding rate, open interest) | ⭐⭐ | Lepszy kontekst |
| Ensemble: Chronos + XGBoost + klasyczna statystyka | ⭐⭐⭐ | Stabilniejszy edge |
| Kelly sizing zamiast flat bet | ⭐⭐ | Wyższy zwrot |
| Więcej par (SOL, MATIC) do lag monitora | ⭐ | Więcej okazji |

### Długoterminowe

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Fine-tuning na danych Polymarket (resolution history) | ⭐⭐⭐⭐ | Największy skok jakości |
| Multi-asset: korelacje BTC-ETH-SOL | ⭐⭐⭐ | Lepsze sygnały |
| Sentiment analysis (Twitter/news) jako dodatkowy sygnał | ⭐⭐⭐ | Kontekst makro |
| Automatyczny paper trading z virtual bankrollem | ⭐⭐ | Walidacja bez ryzyka |

---

## 14. Struktura plików

```
C:\Users\markowyy\Documents\Polymarket\
├── scanner/
│   ├── bot.ts              # Główna pętla skanowania + Double Confirmation
│   ├── lag-monitor.ts      # Lag Monitor (spot ↔ poly, co 5s)
│   ├── binance-ws.ts       # Binance WebSocket feed (BTCUSDT, ETHUSDT)
│   ├── polymarket.ts       # Integracja Polymarket CLOB API
│   ├── backfill.ts         # Wypełnianie danymi historycznymi
│   └── init-db.ts          # Inicjalizacja bazy danych
├── sidecar/
│   ├── main.py             # FastAPI + Chronos inference
│   └── requirements.txt
├── dashboard/
│   ├── app/
│   │   ├── page.tsx        # Główny layout dashboardu
│   │   └── api/            # Endpointy: edges, equity, stats, pnl, system-status, lag
│   └── components/
│       ├── PnlChart.tsx    # Wykres PNL per rynek (5 zakładek)
│       ├── SignalCard.tsx  # Ostatni sygnał z POLY LIVE badge
│       ├── TradeLedger.tsx # Historia transakcji (przewijana)
│       ├── MarketYield.tsx # Trafność per rynek
│       ├── StatsBar.tsx    # Górny pasek KPI
│       └── LagMonitor.tsx  # Wizualizacja Lag Monitora (wykres + snapshot)
├── backtest/
│   ├── simulate.py         # Symulacja flat bet z filtrami
│   ├── simulate_all.py     # Raport wszystkich rynków
│   ├── simple.py           # Surowa dokładność
│   ├── kelly.py            # Kelly sizing backtest
│   └── diagnose.py         # Diagnostyka cen yes_price
├── research/
│   ├── calibration.py      # Kalibracja modelu (Brier score, ECE)
│   ├── calibrate_lag.py    # Kalibracja Lag Monitora (sensitivity, threshold)
│   ├── recalibrate_confidence.py  # Platt scaling (Brier 0.44→0.25)
│   ├── correlate_signals.py       # Korelacja Chronos vs Lag Monitor
│   └── db_status.py        # Szybki podgląd bazy danych
├── kronos.db               # Baza SQLite (persystentna)
├── schema.sql              # Schemat bazy danych
├── start.bat               # Uruchamia wszystkie 3 serwisy
└── KRONOS.md               # Ten dokument
```

---

## 15. Historia kalibracji

| Data | Co się stało | Wynik |
|---|---|---|
| 2026-04-26 | Pierwsze uruchomienie bota | Zbieranie danych |
| 2026-05-06 | Pierwsza analiza (137 trades, 51.8% WR) | Sensitivity 50 (za niskie) |
| 2026-05-08 | Kalibracja Lag Monitora v1 | sensitivity 444/383/251/202, threshold 13pp |
| 2026-05-08 | Platt Scaling v1 | Brier Score 0.37→0.25 |
| 2026-05-10 | 48h danych: Chronos = 49.9% WR (random) | Potwierdzenie overconfidence |
| 2026-05-10 | Kalibracja Lag Monitora v2 | sensitivity 598/553/331/286, threshold 17.4pp |
| 2026-05-10 | Platt Scaling v2 (nowe dane) | Brier Score 0.44→0.25 |
| 2026-05-10 | Korelacja sygnałów: Double Confirmation | 68.4% WR (19 trades) |
| 2026-05-10 | Wdrożenie Double Confirmation w kodzie | 🟢DC/🔴DC w logu bota |

---

## 16. Ważne ostrzeżenia

> **To jest system badawczy, nie produkcyjny bot tradingowy.**
>
> - Backtest accuracy ≠ live trading edge
> - Chronos nie był trenowany na danych krypto/Polymarket
> - 19 zgodnych trades Double Confirmation to za mało na statystycznie istotne wnioski
> - Polymarket ma Region Restrictions — sprawdź regulamin przed handlem
> - Nie inwestuj więcej niż możesz stracić
>
> Patrz: Chapter 14 workbooka dla pełnej listy production gaps.

---

*Wygenerowano automatycznie przez KRONOS TERMINAL v2.0*
