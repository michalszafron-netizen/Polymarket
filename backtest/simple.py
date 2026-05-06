"""
KRONOS BACKTEST — simple.py

Measures raw directional accuracy of Kronos predictions stored in SQLite.
Reads resolved edges and computes:
  - Total predictions count
  - Raw accuracy (all predictions)
  - Gated accuracy (confidence >= gate)
  - Gated count and win rate

Usage:
    python backtest/simple.py
    python backtest/simple.py --market "BTC 5-Min Up/Down" --gate 0.65
"""

import sqlite3
import argparse
import pandas as pd
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "kronos.db"


def load_resolved_edges(market: str) -> pd.DataFrame:
    """Load all resolved edges for a given market."""
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql(
        """
        SELECT ts, direction, confidence, prob_up, prob_down,
               ev, kelly, anchor_price, resolve_price, correct
        FROM edges
        WHERE market = ? AND resolved = 1
        ORDER BY ts ASC
        """,
        con,
        params=(market,),
    )
    con.close()
    return df


def run_accuracy_report(market: str, conf_gate: float = 0.65):
    """Print raw and gated accuracy metrics."""
    df = load_resolved_edges(market)

    if df.empty:
        print(f"No resolved edges found for '{market}'.")
        print("Run backfill first: cd scanner && pnpm run backfill")
        return

    total = len(df)
    wins = df["correct"].sum()
    raw_acc = wins / total

    gated = df[df["confidence"] >= conf_gate]
    gated_count = len(gated)
    gated_wins = gated["correct"].sum()
    gated_acc = gated_wins / gated_count if gated_count > 0 else 0

    print(f"\n{'═' * 50}")
    print(f"  KRONOS RAW ACCURACY REPORT")
    print(f"  Market: {market}")
    print(f"{'═' * 50}")
    print(f"  Total predictions : {total}")
    print(f"  Raw accuracy      : {raw_acc:.1%}")
    print(f"  Gated (>={conf_gate:.0%})     : {gated_count} predictions")
    print(f"  Gated accuracy    : {gated_acc:.1%}")
    print(f"  Mean confidence   : {df['confidence'].mean():.1%}")
    print(f"  Mean EV           : {df['ev'].mean():.1%}")
    print(f"{'═' * 50}\n")

    # Confidence bucket breakdown
    print("  Confidence Buckets:")
    bins = [0.5, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 1.0]
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (df["confidence"] >= lo) & (df["confidence"] < hi)
        subset = df[mask]
        if len(subset) == 0:
            continue
        acc = subset["correct"].mean()
        print(f"    {lo:.0%}-{hi:.0%}: {len(subset):4d} preds | {acc:.1%} accuracy")

    return df


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Kronos raw accuracy backtest")
    parser.add_argument("--market", default="BTC 5-Min Up/Down", help="Market name")
    parser.add_argument("--gate", type=float, default=0.65, help="Confidence gate")
    args = parser.parse_args()

    run_accuracy_report(args.market, args.gate)
