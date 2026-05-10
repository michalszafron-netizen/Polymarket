"""
KRONOS LAG CALIBRATION — calibrate_lag.py

Cel: znaleźć prawdziwą wrażliwość Polymarketu na ruch spot.
Na podstawie danych z lag_log (Binance WS spot vs Polymarket CLOB midpoint)
wykonuje regresję liniową: poly_yes ~ spot_change_pct.
Następnie ustala realny threshold sygnału (percentyl |lag|).

Użycie:
    python research/calibrate_lag.py
    python research/calibrate_lag.py --window-max 150    (tylko pierwsza połowa okna 5M)

Output:
    - Prawdziwa sensitivity per rynek
    - Nowy threshold (95. percentyl |lag| po kalibracji)
    - Proponowane wartości do wstawienia w lag-monitor.ts
"""

import sqlite3
import argparse
import numpy as np
from pathlib import Path
from scipy import stats

DB_PATH = Path(__file__).parent.parent / "kronos.db"

MARKETS = [
    {"name": "BTC 5-Min Up/Down",  "symbol": "BTCUSDT", "interval_min": 5},
    {"name": "ETH 5-Min Up/Down",  "symbol": "ETHUSDT", "interval_min": 5},
    {"name": "BTC 15-Min Up/Down", "symbol": "BTCUSDT", "interval_min": 15},
    {"name": "ETH 15-Min Up/Down", "symbol": "ETHUSDT", "interval_min": 15},
]


def load_data(market_name: str, window_max_sec: int | None = None) -> np.ndarray | None:
    """Pobiera próbki lag_log dla danego rynku, gdzie mamy poly_yes."""
    con = sqlite3.connect(DB_PATH)

    query = """
        SELECT spot_change_pct, poly_yes
        FROM lag_log
        WHERE market = ?
          AND poly_yes IS NOT NULL
          AND poly_yes BETWEEN 0.10 AND 0.90
    """
    params = [market_name]

    if window_max_sec is not None:
        query += " AND window_sec_in < ?"
        params.append(window_max_sec)

    cursor = con.execute(query, params)
    rows = cursor.fetchall()
    con.close()

    if len(rows) < 20:
        return None

    return np.array(rows, dtype=np.float64)


def compute_sensitivity(data: np.ndarray) -> dict:
    """
    Regresja liniowa: poly_yes = α + β × spot_change_pct
    β to prawdziwa wrażliwość (jak poly reaguje na 1% ruchu spot)
    α to bazowe prawdopodobieństwo przy braku ruchu (powinno być ~0.5)
    """
    x = data[:, 0]  # spot_change_pct
    y = data[:, 1]  # poly_yes

    slope, intercept, r_value, p_value, std_err = stats.linregress(x, y)

    return {
        "slope": slope,           # β — wrażliwość na 1% zmiany spot
        "sensitivity_pp": slope * 100,  # wrażliwość: ile pp poly zmienia się na 1% spot
        "intercept": intercept,   # α — bazowe poly_yes przy spot_change=0
        "r_squared": r_value ** 2,
        "p_value": p_value,
        "std_err": std_err,
        "n": len(data),
    }


def compute_calibrated_fair(data: np.ndarray, slope: float, intercept: float) -> np.ndarray:
    """Liczy fair_yes z wykalibrowanym modelem, potem lag = fair - poly."""
    fair = intercept + data[:, 0] * slope
    fair = np.clip(fair, 0.02, 0.98)
    lag_pp = (fair - data[:, 1]) * 100  # w punktach procentowych
    return lag_pp


def suggest_threshold(lag_pp: np.ndarray) -> dict:
    """Ustala threshold jako 95. percentyl |lag| (tylko sygnały skrajne)."""
    abs_lag = np.abs(lag_pp)
    return {
        "p50": float(np.percentile(abs_lag, 50)),
        "p75": float(np.percentile(abs_lag, 75)),
        "p90": float(np.percentile(abs_lag, 90)),
        "p95": float(np.percentile(abs_lag, 95)),
        "p99": float(np.percentile(abs_lag, 99)),
        "mean_abs": float(np.mean(abs_lag)),
        "std_abs": float(np.std(abs_lag)),
        "recommended_threshold": float(np.percentile(abs_lag, 95)),
        "signal_fraction_pct": float(np.mean(abs_lag > np.percentile(abs_lag, 95)) * 100),
    }


def analyze_market(market: dict, window_max_sec: int | None) -> dict | None:
    """Pełna analiza dla jednego rynku."""
    data = load_data(market["name"], window_max_sec)
    if data is None:
        return None

    sens = compute_sensitivity(data)
    lag_pp = compute_calibrated_fair(data, sens["slope"], sens["intercept"])
    threshold = suggest_threshold(lag_pp)

    return {
        "market": market["name"],
        **sens,
        **threshold,
    }


def main():
    parser = argparse.ArgumentParser(description="Kalibracja lag monitora — spot vs Polymarket")
    parser.add_argument(
        "--window-max",
        type=int,
        default=None,
        help="Maksymalny window_sec_in (np. 150 dla pierwszej połowy 5M)",
    )
    parser.add_argument(
        "--filter-window",
        action="store_true",
        default=True,
        help="Filtruj tylko pierwszą połowę okien (domyślnie)",
    )
    args = parser.parse_args()

    window_max_5m = 150 if args.filter_window else None
    window_max_15m = 270 if args.filter_window else None

    print(f"\n{'═' * 72}")
    print(f"  KRONOS LAG CALIBRATION — Spot vs Polymarket Sensitivity")
    print(f"  Dane: {DB_PATH}")
    if args.filter_window:
        print(f"  Filtr okna: 5M < 150s, 15M < 270s (pierwsza połowa)")
    else:
        print(f"  Filtr okna: BRAK (wszystkie próbki)")
    print(f"{'═' * 72}\n")

    results = []
    for m in MARKETS:
        wmax = window_max_5m if m["interval_min"] == 5 else window_max_15m
        r = analyze_market(m, wmax)
        if r:
            results.append(r)

    if not results:
        print("  ❌ Brak danych do analizy. Uruchom bota i zbierz minimum 20 próbek/rynek.\n")
        return

    # ─── Tabela wyników ────────────────────────────────────────────────────
    print(f"  {'Rynek':<22} {'N':>6} {'Intercept':>9} {'Sens/1%':>9} {'R²':>6} {'Reko.P95':>9} {'Sygnały%':>9}")
    print(f"  {'─'*22} {'─'*6} {'─'*9} {'─'*9} {'─'*6} {'─'*9} {'─'*9}")

    for r in results:
        sens_disp = f"{r['sensitivity_pp']:.2f}pp"
        thresh_disp = f"{r['recommended_threshold']:.2f}pp"
        sig_disp = f"{r['signal_fraction_pct']:.1f}%"
        print(
            f"  {r['market']:<22} {r['n']:>6} "
            f"{r['intercept']:>8.4f}  {sens_disp:>8} {r['r_squared']:>5.3f} "
            f"{thresh_disp:>9} {sig_disp:>8}"
        )

    # ─── Dla porównania: BEZ filtra okna ──────────────────────────────────
    print(f"\n  {'─'*72}")
    print(f"  DLA PORÓWNANIA — BEZ filtra okna (wszystkie próbki):")
    print(f"  {'─'*72}\n")
    print(f"  {'Rynek':<22} {'N':>6} {'Intercept':>9} {'Sens/1%':>9} {'R²':>6} {'Reko.P95':>9} {'Sygnały%':>9}")
    print(f"  {'─'*22} {'─'*6} {'─'*9} {'─'*9} {'─'*6} {'─'*9} {'─'*9}")

    for m in MARKETS:
        r_raw = analyze_market(m, None)
        if r_raw:
            sens_disp = f"{r_raw['sensitivity_pp']:.2f}pp"
            thresh_disp = f"{r_raw['recommended_threshold']:.2f}pp"
            sig_disp = f"{r_raw['signal_fraction_pct']:.1f}%"
            print(
                f"  {r_raw['market']:<22} {r_raw['n']:>6} "
                f"{r_raw['intercept']:>8.4f}  {sens_disp:>8} {r_raw['r_squared']:>5.3f} "
                f"{thresh_disp:>9} {sig_disp:>8}"
            )

    # ─── Rekomendowane wartości do lag-monitor.ts ─────────────────────────
    print(f"\n  {'═' * 72}")
    print(f"  📋 PROPONOWANE WARTOŚCI DO lag-monitor.ts (z filtrem okna):")
    print(f"  {'═' * 72}")

    print(f"\n  // Zastąp w CFG.markets:")
    for r in results:
        sensitivity_int = max(1, round(r["sensitivity_pp"]))
        print(f"  // {r['market']}: sensitivity = {sensitivity_int} (było {50 if '5-Min' in r['market'] else 30})")

    # Sugerowany globalny threshold
    avg_threshold = np.mean([r["recommended_threshold"] for r in results])
    print(f"\n  // Zastąp w CFG.thresholdPct:")
    print(f"  thresholdPct: {avg_threshold:.1f}  // było 3.0")
    print(f"\n  {'═' * 72}\n")


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print("\n  ❌ Brak scipy. Zainstaluj: pip install scipy\n")
        print("  Prosta wersja bez scipy (tylko numpy):\n")

        # Fallback bez scipy — regresja ręczna
        for m in MARKETS:
            data = load_data(m["name"], 150 if m["interval_min"] == 5 else 270)
            if data is None:
                continue
            x = data[:, 0]
            y = data[:, 1]
            n = len(x)
            if n < 3:
                continue

            # Regresja metodą najmniejszych kwadratów
            x_mean = np.mean(x)
            y_mean = np.mean(y)
            slope = np.sum((x - x_mean) * (y - y_mean)) / np.sum((x - x_mean) ** 2)
            intercept = y_mean - slope * x_mean

            # R²
            y_pred = intercept + slope * x
            ss_res = np.sum((y - y_pred) ** 2)
            ss_tot = np.sum((y - y_mean) ** 2)
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

            # Lag z wykalibrowanym modelem
            fair = intercept + x * slope
            fair = np.clip(fair, 0.02, 0.98)
            lag_pp = (fair - y) * 100
            abs_lag = np.abs(lag_pp)
            p95 = np.percentile(abs_lag, 95)

            sens_pp = slope * 100
            sens_int = max(1, round(sens_pp))
            print(
                f"  {m['name']:<22} N={n:>5}  intercept={intercept:.4f}  "
                f"sens={sens_pp:.2f}pp/1%  R²={r2:.3f}  reko_threshold={p95:.2f}pp  "
                f"sygnały={np.mean(abs_lag > p95) * 100:.1f}%  → sensitivity={sens_int}"
            )
        print()