# KRONOS TERMINAL — Dokumentacja Systemu

> Wersja: 1.0 | Data: 2026-05-06 | Status: Live (Research Mode)

---

## 1. Co to jest

KRONOS to system badawczy do wykrywania i analizowania statystycznych przewag (edge) na rynkach predykcyjnych Polymarket. Łączy dane cenowe z Bybit z modelem AI (Amazon Chronos) aby generować predykcje kierunku ceny BTC i ETH, które następnie konfrontuje z realnymi kursami z Polymarket CLOB.

**Nie jest to bot tradingowy** — system nie wykonuje żadnych zleceń automatycznie. Generuje sygnały i mierzy ich historyczną trafność.

---

## 2. Architektura systemu

```
┌─────────────────────────────────────────────────────────────────┐
│                        KRONOS TERMINAL                          │
├──────────────┬──────────────────────┬───────────────────────────┤
│   SCANNER    │       SIDECAR        │        DASHBOARD          │
│  (Node.js)   │      (Python)        │       (Next.js)           │
│              │                      │                           │
│ Co 5 minut:  │  POST /predict       │  localhost:3000           │
│ 1. Bybit API │  ──────────────────► │  - PNL Chart (5 rynków)   │
│ 2. Chronos   │  Amazon Chronos T5   │  - Signal Radar           │
│ 3. Poly CLOB │  200M parametrów     │  - Trade Ledger           │
│ 4. SQLite    │  CPU inference       │  - System Status          │
│              │  ~1.3s/predykcja     │  - Prediction Console     │
└──────────────┴──────────────────────┴───────────────────────────┘
                              │
                        kronos.db
                       (SQLite WAL)
```

### Komponenty

| Komponent | Technologia | Port | Rola |
|---|---|---|---|
| Scanner Bot | TypeScript + Node.js | — | Orkiestracja, zapis danych |
| Sidecar | Python + FastAPI | 8000 | Inference AI |
| Dashboard | Next.js 15 + React | 3000 | Wizualizacja |
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
   f) Zapisz edge do SQLite

4. LOG do konsoli:
   ✅ 🤖 BTC 5M → DOWN 93% | EV 59% | K 83% | 1308ms [POLY:0.415 [+8s]]
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

---

## 4. Model AI — Amazon Chronos T5-base

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

## 5. Integracja Polymarket

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

## 6. Wyniki po ~6 godzinach działania (live, POLY ceny)

> Dane zebrane: 2026-05-06, $1/trade flat bet, $100 budżet

| Rynek | Trades | Win% | PNL | ROI | Max DD | Avg Pay |
|---|---|---|---|---|---|---|
| BTC 5-Min | ~40 | 47.5% | +$1.06 | +1.1% | 6.4% | 2.29x |
| ETH 5-Min | ~42 | **57.1%** | **+$9.82** | **+9.8%** | 3.6% | 2.44x |
| BTC 15-Min | ~27 | 51.9% | +$0.21 | +0.2% | 5.1% | 2.41x |
| ETH 15-Min | ~28 | 50.0% | +$7.75 | +7.7% | 4.5% | 2.55x |
| **ŁĄCZNIE** | **137** | **51.8%** | **+$18.84** | **+18.8%** | 7.6% | — |

**Próbka zbyt mała** — minimum wiarygodne to 200 trades/rynek. Wyniki z jednego dnia to szum statystyczny, nie dowód edge.

---

## 7. Wady systemu

### Krytyczne
- **Brak egzekucji** — system nie składa zleceń, wszystko manualne
- **Brak zarządzania ryzykiem** — Kelly criterion wymaga kalibracji
- **Chronos nie był fine-tunowany** na krypto ani Polymarket — zero-shot
- **CPU inference** — 1.3s/predykcja, przy GPU byłoby 50ms

### Istotne
- **Brak Chainlink oracle** — rozwiązujemy edgespo cenie Bybit, Polymarket używa Chainlink (drobne rozbieżności)
- **Brak spread/slippage** — backtest zakłada idealne wejście po mid-price
- **Brak position limits** — Kelly może sugerować duże pozycje na małej próbce
- **Model bias** — Chronos ma 54% YES / 46% NO bias (widoczny w Model Bias)

### Mniejsze
- Brak obsługi błędów połączenia Polymarket (fallback na 0.51)
- NEXT RESOLVE timer zakłada że rynki otwierają się co okrągłe 5 min UTC (co jest prawdą, ale może nie zawsze)
- Dashboard nie pokazuje rzeczywistego P&L w czasie rzeczywistym (symulacja)

---

## 8. Zalety systemu

- **Lokalne AI** — zero kosztów inference, Chronos działa na własnym CPU/GPU
- **Prawdziwe ceny Polymarket** — CLOB midpoint zamiast symulowanych 0.51
- **Synchronizacja czasowa** — scanner startuje 2s przed otwarciem okna
- **Filtr okna** — odrzuca sygnały z połowy/końca okna (zatruty pricing)
- **Persystentna baza** — SQLite WAL, dane nie giną przy restarcie
- **Pełny pipeline backtestowy** — simulate_all.py, simple.py, kelly.py, diagnose.py
- **Dashboard live** — PNL chart trade-po-tradzie, system status, POLY LIVE badge

---

## 9. Jak uruchomić

```powershell
# Uruchom wszystko jednym plikiem:
start.bat

# Lub ręcznie (3 okna PowerShell):

# Okno 1 — Sidecar AI
cd C:\Users\markowyy\Documents\Polymarket\sidecar
python -m uvicorn main:app --host 0.0.0.0 --port 8000

# Okno 2 — Scanner
cd C:\Users\markowyy\Documents\Polymarket\scanner
npx tsx bot.ts

# Okno 3 — Dashboard
cd C:\Users\markowyy\Documents\Polymarket\dashboard
pnpm dev

# Przełączenie na GBM (awaryjnie):
$env:INFERENCE_MODE = "gbm"
```

---

## 10. Narzędzia analityczne

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
```

---

## 11. Możliwości testowania

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

---

## 12. Możliwości ulepszenia

### Krótkoterminowe (bez dużych zmian)

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Zwiększyć n_samples 100→500 po zwolnieniu miejsca na GPU | ⭐ | Dokładniejsze prob |
| Dodać filtr confidence gate w scannerze (zapisuj tylko >60%) | ⭐ | Czystsze dane |
| Fine-tuning Chronosa na historycznych danych BTC/ETH | ⭐⭐⭐ | +5-10% accuracy |
| Dodać więcej rynków (SOL, MATIC) | ⭐ | Więcej okazji |

### Średnioterminowe

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Egzekucja przez Polymarket API (składanie zleceń) | ⭐⭐⭐ | Przejście do live trading |
| Chainlink oracle jako resolve source (zamiast Bybit) | ⭐⭐ | Dokładniejszy resolve |
| Dodanie on-chain data (funding rate, open interest) | ⭐⭐ | Lepszy kontekst |
| Ensemble: Chronos + XGBoost + klasyczna statystyka | ⭐⭐⭐ | Stabilniejszy edge |
| Kelly sizing zamiast flat bet | ⭐⭐ | Wyższy zwrot |

### Długoterminowe

| Ulepszenie | Trudność | Impact |
|---|---|---|
| Fine-tuning na danych Polymarket (resolution history) | ⭐⭐⭐⭐ | Największy skok jakości |
| Multi-asset: korelacje BTC-ETH-SOL | ⭐⭐⭐ | Lepsze sygnały |
| Sentiment analysis (Twitter/news) jako dodatkowy sygnał | ⭐⭐⭐ | Kontekst makro |
| Automatyczny paper trading z virtual bankrollem | ⭐⭐ | Walidacja bez ryzyka |

---

## 13. Struktura plików

```
C:\Users\markowyy\Documents\Polymarket\
├── scanner/
│   ├── bot.ts              # Główna pętla skanowania
│   ├── backfill.ts         # Wypełnianie danymi historycznymi
│   ├── polymarket.ts       # Integracja Polymarket CLOB API
│   └── init-db.ts          # Inicjalizacja bazy danych
├── sidecar/
│   ├── main.py             # FastAPI + Chronos inference
│   └── requirements.txt
├── dashboard/
│   ├── app/
│   │   ├── page.tsx        # Główny layout dashboardu
│   │   └── api/            # Endpointy: edges, equity, stats, pnl, system-status
│   └── components/
│       ├── PnlChart.tsx    # Wykres PNL per rynek (5 zakładek)
│       ├── SignalCard.tsx  # Ostatni sygnał z POLY LIVE badge
│       ├── TradeLedger.tsx # Historia transakcji (przewijana)
│       ├── MarketYield.tsx # Trafność per rynek
│       └── StatsBar.tsx    # Górny pasek KPI
├── backtest/
│   ├── simulate.py         # Symulacja flat bet z filtrami
│   ├── simulate_all.py     # Raport wszystkich rynków
│   ├── simple.py           # Surowa dokładność
│   ├── kelly.py            # Kelly sizing backtest
│   └── diagnose.py         # Diagnostyka cen yes_price
├── research/
│   └── calibration.py      # Kalibracja modelu (Brier score, ECE)
├── kronos.db               # Baza SQLite (persystentna)
├── schema.sql              # Schemat bazy danych
├── start.bat               # Uruchamia wszystkie 3 serwisy
└── KRONOS.md               # Ten dokument
```

---

## 14. Ważne ostrzeżenia

> **To jest system badawczy, nie produkcyjny bot tradingowy.**
>
> - Backtest accuracy ≠ live trading edge
> - Chronos nie był trenowany na danych krypto/Polymarket
> - 137 trades (1 dzień) to za mało na statystycznie istotne wnioski
> - Polymarket ma Region Restrictions — sprawdź regulamin przed handlem
> - Nie inwestuj więcej niż możesz stracić
>
> Patrz: Chapter 14 workbooka dla pełnej listy production gaps.

---

*Wygenerowano automatycznie przez KRONOS TERMINAL v1.0*
