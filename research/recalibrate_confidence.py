"""
KRONOS CONFIDENCE RECALIBRATION — recalibrate_confidence.py

Problem: Chronos confidence jest bardzo overconfident.
Gdy model mówi 95% → trafia ~50% (Brier Score ~0.37 na wszystkich rynkach).

Rozwiązanie: Platt scaling — regresja logistyczna mapująca raw Chronos confidence
na skalibrowane prawdopodobieństwo.

  calibrated = 1 / (1 + exp(-(A * confidence + B)))

Gdzie A i B to współczynniki skalowania wyuczone na podstawie resolved edges.

Użycie:
    python research/recalibrate_confidence.py
    python research/recalibrate_confidence.py --market "BTC 5-Min Up/Down"

Output:
    - Współczynniki A, B per rynek
    - Porównanie Brier Score przed/po
    - Krzywa kalibracji przed/po
    - Kod do wstawienia w bot.ts
"""

import sqlite3
import argparse
import numpy as np
from pathlib import Path
from scipy.special import expit  # sigmoid = 1/(1+exp(-x))

DB_PATH = Path(__file__).parent.parent / "kronos.db"

MARKETS = [
    "BTC 5-Min Up/Down",
    "ETH 5-Min Up/Down",
    "BTC 15-Min Up/Down",
    "ETH 15-Min Up/Down",
]


def load_resolved(market: str | None = None) -> np.ndarray | None:
    """Pobiera confidence i correct dla rozwiązanych edges."""
    con = sqlite3.connect(DB_PATH)
    query = """
        SELECT confidence, correct
        FROM edges
        WHERE resolved = 1
          AND ABS(yes_price - 0.51) > 0.005
          AND yes_price BETWEEN 0.10 AND 0.90
    """
    params = []
    if market:
        query += " AND market = ?"
        params.append(market)

    rows = con.execute(query, params).fetchall()
    con.close()

    if len(rows) < 30:
        return None

    return np.array(rows, dtype=np.float64)


def brier_score(probs: np.ndarray, outcomes: np.ndarray) -> float:
    """Brier Score = (1/N) * Σ(prob - outcome)^2"""
    return float(np.mean((probs - outcomes) ** 2))


def calibration_curve(probs: np.ndarray, outcomes: np.ndarray, n_bins: int = 10) -> list:
    """Krzywa kalibracji per bucket."""
    bins = np.linspace(0.5, 1.0, n_bins + 1)
    rows = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (probs >= lo) & (probs < hi)
        if mask.sum() < 3:
            continue
        rows.append({
            "bin": f"{lo:.0%}-{hi:.0%}",
            "count": int(mask.sum()),
            "predicted": float(probs[mask].mean()),
            "observed": float(outcomes[mask].mean()),
            "gap": abs(float(probs[mask].mean()) - float(outcomes[mask].mean())),
        })
    return rows


def fit_platt_scaling(confidence: np.ndarray, correct: np.ndarray) -> tuple[float, float]:
    """
    Dopasowuje Platt scaling: calibrated = sigmoid(A * confidence + B)
    Metoda: regresja logistyczna na confidence jako jedynej cesze.
    Alternatywnie używa prostszej metody momentów jeśli scipy nie działa.

    Returns: (A, B)
    """
    try:
        from scipy.optimize import minimize

        def neg_log_lik(params):
            A, B = params
            z = A * confidence + B
            # log(1 + exp(z)) - correct * z
            return float(np.mean(np.log(1 + np.exp(z)) - correct * z))

        result = minimize(neg_log_lik, [1.0, 0.0], method="BFGS")
        return float(result.x[0]), float(result.x[1])

    except ImportError:
        # Fallback: prosta regresja logistyczna metodą gradient descent
        A, B = 1.0, 0.0
        lr = 0.1
        n_iter = 5000

        for _ in range(n_iter):
            z = A * confidence + B
            p = 1.0 / (1.0 + np.exp(-z))
            dA = np.mean((p - correct) * confidence)
            dB = np.mean(p - correct)
            A -= lr * dA
            B -= lr * dB

        return A, B


def recalibrate_and_report(market: str | None, label: str) -> dict | None:
    """Pełna rekalibracja dla jednego rynku: platt scaling + raport."""
    data = load_resolved(market)
    if data is None:
        return None

    confidence = data[:, 0]
    correct = data[:, 1]
    n = len(confidence)

    # Brier Score przed
    bs_before = brier_score(confidence, correct)

    # Dopasuj Platt scaling
    A, B = fit_platt_scaling(confidence, correct)
    calibrated = expit(A * confidence + B)

    # Brier Score po
    bs_after = brier_score(calibrated, correct)

    # Krzywe kalibracji
    curve_before = calibration_curve(confidence, correct)
    curve_after = calibration_curve(calibrated, correct)

    return {
        "market": label,
        "n": n,
        "A": A,
        "B": B,
        "bs_before": bs_before,
        "bs_after": bs_after,
        "bs_improvement": bs_before - bs_after,
        "curve_before": curve_before,
        "curve_after": curve_after,
    }


def main():
    parser = argparse.ArgumentParser(description="Rekalibracja confidence Chronosa — Platt scaling")
    parser.add_argument("--market", default=None)
    args = parser.parse_args()

    print(f"\n{'═' * 72}")
    print(f"  KRONOS CONFIDENCE RECALIBRATION — Platt Scaling")
    print(f"  Dane: {DB_PATH}")
    print(f"{'═' * 72}\n")

    targets = [args.market] if args.market else MARKETS
    all_results = []

    for mkt in targets:
        r = recalibrate_and_report(mkt if args.market else mkt, mkt)
        if r:
            all_results.append(r)

    if not all_results:
        print("  ❌ Brak danych do rekalibracji.\n")
        return

    # ─── Tabela wyników ────────────────────────────────────────────────────
    print(f"  {'Rynek':<22} {'N':>6} {'A':>8} {'B':>8} {'BS przed':>9} {'BS po':>9} {'Poprawa':>9}")
    print(f"  {'─'*22} {'─'*6} {'─'*8} {'─'*8} {'─'*9} {'─'*9} {'─'*9}")

    for r in all_results:
        bs_symbol = "✅" if r["bs_after"] < 0.25 else "⚠️"
        print(
            f"  {r['market']:<22} {r['n']:>6} "
            f"{r['A']:>8.3f} {r['B']:>8.3f} "
            f"{r['bs_before']:>8.4f}  {r['bs_after']:>8.4f} "
            f"{bs_symbol} {r['bs_improvement']:>+.4f}"
        )

    # ─── Szczegółowe krzywe dla każdego rynku ──────────────────────────────
    for r in all_results:
        print(f"\n  {'─' * 72}")
        print(f"  {r['market']} — Krzywa kalibracji PRZED vs PO")
        print(f"  {'─' * 72}")
        print(f"  {'Bin':>10}  {'N':>5}  {'PRZED pred':>10} {'obs':>6}  {'PO pred':>10} {'obs':>6}")
        print(f"  {'─' * 64}")

        for cb, ca in zip(r["curve_before"], r["curve_after"]):
            print(
                f"  {cb['bin']:>10}  {cb['count']:5}  "
                f"{cb['predicted']:>10.1%} {cb['observed']:>5.1%}   "
                f"{ca['predicted']:>10.1%} {ca['observed']:>5.1%}"
            )

    # ─── Kod do wstawienia w bot.ts ─────────────────────────────────────────
    print(f"\n  {'═' * 72}")
    print(f"  📋 KOD DO WSTAWIENIA W bot.ts (funkcja recalibrate):")
    print(f"  {'═' * 72}")
    print(f"\n  // Platt scaling coefficients (python research/recalibrate_confidence.py)")
    print(f"  const PLATT: Record<string, [number, number]> = {{")
    for r in all_results:
        print(f"    \"{r['market']}\": [{r['A']:.4f}, {r['B']:.4f}],")
    print(f"  }};")
    print(f"\n  function recalibrate(rawConfidence: number, market: string): number {{")
    print(f"    const [A, B] = PLATT[market] ?? [1, 0];")
    print(f"    const z = A * rawConfidence + B;")
    print(f"    return 1 / (1 + Math.exp(-z));  // sigmoid")
    print(f"  }}")
    print(f"\n  // Użycie: zamiast pred.confidence → recalibrate(pred.confidence, market.name)")
    print(f"\n  {'═' * 72}\n")


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print("\n  ❌ Brak scipy/numpy. Zainstaluj: pip install scipy numpy\n")
        print("  Uruchamiam uproszczoną wersję z ręcznym gradient descent...\n")

        # Fallback: tylko numpy
        for mkt in MARKETS:
            data = load_resolved(mkt)
            if data is None:
                continue
            confidence = data[:, 0]
            correct = data[:, 1]

            bs_before = brier_score(confidence, correct)

            # Gradient descent na Platt scaling
            A, B = 1.0, 0.0
            lr = 0.1
            for _ in range(5000):
                z = A * confidence + B
                p = 1.0 / (1.0 + np.exp(-np.clip(z, -50, 50)))
                dA = np.mean((p - correct) * confidence)
                dB = np.mean(p - correct)
                A -= lr * dA
                B -= lr * dB

            calibrated = 1.0 / (1.0 + np.exp(-np.clip(A * confidence + B, -50, 50)))
            bs_after = brier_score(calibrated, correct)
            improvement = bs_before - bs_after
            bs_symbol = "✅" if bs_after < 0.25 else "⚠️"

            print(
                f"  {mkt:<22} N={len(confidence):>5}  "
                f"A={A:.3f}  B={B:.3f}  "
                f"BS: {bs_before:.4f}→{bs_after:.4f}  {bs_symbol} {improvement:+.4f}"
            )
        print()