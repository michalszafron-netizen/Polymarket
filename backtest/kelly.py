"""
KRONOS BACKTEST — kelly.py

Kelly Criterion sizing simulation. Tests multiple strategies:
  - Flat stake
  - Kelly (no indicator gate)
  - Kelly + EV gate
  - Kelly + confidence gate
  - Martingale
  - Kelly x Martingale

Usage:
    python backtest/kelly.py
    python backtest/kelly.py --market "BTC 5-Min Up/Down" --bankroll 10000
"""

import sqlite3
import argparse
import pandas as pd
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "kronos.db"


def kelly_fraction(prob_win: float, payout: float) -> float:
    """Compute Kelly fraction: f* = (bp - q) / b"""
    b = payout - 1
    q = 1 - prob_win
    if b <= 0:
        return 0.0
    f = (b * prob_win - q) / b
    return max(0.0, min(f, 1.0))


def load_edges(market: str) -> pd.DataFrame:
    """Load resolved edges sorted chronologically."""
    con = sqlite3.connect(DB_PATH)
    df = pd.read_sql(
        """
        SELECT ts, direction, confidence, prob_up, ev, kelly, correct
        FROM edges
        WHERE market = ? AND resolved = 1
        ORDER BY ts ASC
        """,
        con,
        params=(market,),
    )
    con.close()
    return df


def simulate(
    df: pd.DataFrame,
    strategy: str = "kelly_gate",
    bankroll: float = 1000.0,
    payout: float = 1.96,
    max_kelly: float = 0.25,
    conf_gate: float = 0.65,
    ev_gate: float = 0.0,
    flat_stake: float = 50.0,
    martingale: bool = False,
) -> dict:
    """
    Simulate a betting strategy over resolved edges.

    Returns dict with: strategy, bets, wins, losses, win_pct,
    final_bankroll, pnl, max_drawdown, equity_curve.
    """
    bal = bankroll
    peak = bankroll
    max_dd = 0.0
    streak = 0
    wins = 0
    losses = 0
    equity = [bankroll]

    for _, row in df.iterrows():
        # Apply gates
        if row["confidence"] < conf_gate:
            continue
        if row["ev"] is not None and row["ev"] < ev_gate:
            continue

        # Compute stake
        if strategy == "flat":
            stake = flat_stake
        else:
            f = kelly_fraction(row["confidence"], payout)
            f = min(f, max_kelly)
            if martingale and streak > 0:
                f = min(f * (2 ** streak), 0.5)
            stake = bal * f

        if stake < 1 or stake > bal:
            continue

        # Resolve
        correct = bool(row["correct"])
        if correct:
            bal += stake * (payout - 1)
            wins += 1
            streak = 0
        else:
            bal -= stake
            losses += 1
            streak += 1

        equity.append(bal)

        # Track drawdown
        if bal > peak:
            peak = bal
        dd = (peak - bal) / peak if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    total = wins + losses
    return {
        "strategy": strategy + ("+MG" if martingale else ""),
        "bets": total,
        "wins": wins,
        "losses": losses,
        "win_pct": wins / total if total > 0 else 0,
        "final_bankroll": round(bal, 2),
        "pnl": round(bal - bankroll, 2),
        "max_drawdown": round(max_dd, 4),
        "equity": equity,
    }


def save_to_db(market: str, result: dict, params: str = ""):
    """Write backtest result to backtest_runs table."""
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute(
        """
        INSERT INTO backtest_runs
        (market, strategy, bets, wins, losses, win_pct, avg_roi, cum_pnl, max_drawdown, params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            market,
            result["strategy"],
            result["bets"],
            result["wins"],
            result["losses"],
            result["win_pct"],
            result["pnl"] / max(1, result["bets"]),
            result["pnl"],
            result["max_drawdown"],
            params,
        ),
    )
    con.commit()
    con.close()


def main():
    parser = argparse.ArgumentParser(description="Kronos Kelly sizing backtest")
    parser.add_argument("--market", default="BTC 5-Min Up/Down")
    parser.add_argument("--bankroll", type=float, default=1000.0)
    parser.add_argument("--payout", type=float, default=1.96)
    parser.add_argument("--gate", type=float, default=0.65)
    parser.add_argument("--save", action="store_true", help="Save results to SQLite")
    args = parser.parse_args()

    df = load_edges(args.market)
    if df.empty:
        print(f"No resolved edges for '{args.market}'. Run backfill first.")
        return

    print(f"\n{'═' * 60}")
    print(f"  KRONOS KELLY BACKTEST")
    print(f"  Market: {args.market} | Bankroll: ${args.bankroll:,.0f}")
    print(f"  Payout: {args.payout}x | Gate: {args.gate:.0%}")
    print(f"{'═' * 60}\n")

    strategies = [
        ("flat",       {"strategy": "flat", "conf_gate": args.gate}),
        ("kelly",      {"strategy": "kelly_gate", "conf_gate": args.gate}),
        ("kelly+ev",   {"strategy": "kelly_gate", "conf_gate": args.gate, "ev_gate": 0.05}),
        ("kelly+MG",   {"strategy": "kelly_gate", "conf_gate": args.gate, "martingale": True}),
    ]

    for name, kwargs in strategies:
        result = simulate(
            df, bankroll=args.bankroll, payout=args.payout, **kwargs
        )
        pnl_sign = "+" if result["pnl"] >= 0 else ""
        print(
            f"  {result['strategy']:16s} | "
            f"bets={result['bets']:4d} | "
            f"win={result['win_pct']:.1%} | "
            f"PnL={pnl_sign}${abs(result['pnl']):,.0f} | "
            f"DD={result['max_drawdown']:.1%}"
        )

        if args.save:
            save_to_db(args.market, result, str(kwargs))

    if args.save:
        print(f"\n  ✅ Results saved to backtest_runs table")

    print()


if __name__ == "__main__":
    main()
