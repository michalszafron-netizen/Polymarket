"""
KRONOS CALIBRATION — calibration.py

Measures whether the model's stated probabilities match observed frequencies.
A perfectly calibrated model that says 60% should win exactly 60% of the time.

Usage:
    python research/calibration.py
    python research/calibration.py --market "BTC 5-Min Up/Down" --bins 10
"""

import sqlite3
import argparse
import numpy as np
import pandas as pd
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "kronos.db"


def calibration_curve(market: str, n_bins: int = 10) -> pd.DataFrame:
    """Compute calibration curve: predicted confidence vs observed win rate."""
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql(
        """
        SELECT confidence, correct
        FROM edges
        WHERE market = ? AND resolved = 1
        """,
        con,
        params=(market,),
    )
    con.close()

    if df.empty:
        print(f"No resolved edges for '{market}'.")
        return pd.DataFrame()

    bins = np.linspace(0.5, 1.0, n_bins + 1)
    rows = []

    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (df["confidence"] >= lo) & (df["confidence"] < hi)
        sub = df[mask]
        if len(sub) == 0:
            continue

        observed_win_rate = sub["correct"].mean()
        mean_conf = sub["confidence"].mean()

        # Calibration quality
        gap = abs(mean_conf - observed_win_rate)
        if gap < 0.03:
            quality = "✅ Well calibrated"
        elif mean_conf > observed_win_rate:
            quality = "⚠️  Overconfident"
        else:
            quality = "📈 Underconfident"

        rows.append(
            {
                "bin": f"{lo:.0%}-{hi:.0%}",
                "count": len(sub),
                "mean_conf": round(mean_conf, 3),
                "observed": round(observed_win_rate, 3),
                "gap": round(gap, 3),
                "quality": quality,
            }
        )

    return pd.DataFrame(rows)


def brier_score(market: str) -> float:
    """
    Compute Brier Score — lower is better.
    BS = (1/N) * Σ(confidence - correct)^2
    """
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql(
        "SELECT confidence, correct FROM edges WHERE market = ? AND resolved = 1",
        con,
        params=(market,),
    )
    con.close()

    if df.empty:
        return float("nan")

    return float(((df["confidence"] - df["correct"]) ** 2).mean())


def main():
    parser = argparse.ArgumentParser(description="Kronos model calibration analysis")
    parser.add_argument("--market", default="BTC 5-Min Up/Down")
    parser.add_argument("--bins", type=int, default=10)
    args = parser.parse_args()

    print(f"\n{'═' * 60}")
    print(f"  KRONOS CALIBRATION REPORT")
    print(f"  Market: {args.market}")
    print(f"{'═' * 60}\n")

    cal = calibration_curve(args.market, args.bins)
    if cal.empty:
        return

    print("  Calibration Curve:")
    print(f"  {'Bin':>10s}  {'Count':>6s}  {'Claimed':>8s}  {'Observed':>8s}  {'Gap':>5s}  Quality")
    print(f"  {'─' * 56}")

    for _, row in cal.iterrows():
        print(
            f"  {row['bin']:>10s}  {row['count']:6d}  "
            f"{row['mean_conf']:8.1%}  {row['observed']:8.1%}  "
            f"{row['gap']:5.1%}  {row['quality']}"
        )

    bs = brier_score(args.market)
    print(f"\n  Brier Score: {bs:.4f} (lower = better calibrated)")
    print(f"  {'═' * 56}\n")


if __name__ == "__main__":
    main()
