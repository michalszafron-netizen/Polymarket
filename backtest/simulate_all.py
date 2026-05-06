"""
KRONOS — Pełny raport dla wszystkich rynków (tylko dane POLY live).
Uruchom: python backtest/simulate_all.py
"""

import sqlite3
from pathlib import Path

DB = Path(__file__).parent.parent / "kronos.db"

MARKETS = [
    "BTC 5-Min Up/Down",
    "ETH 5-Min Up/Down",
    "BTC 15-Min Up/Down",
    "ETH 15-Min Up/Down",
]

def simulate(market=None, budget=100.0, bet=1.0):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    q = """
        SELECT direction, confidence, yes_price, correct, ts
        FROM edges
        WHERE resolved = 1
          AND ABS(yes_price - 0.51) > 0.005
          AND yes_price BETWEEN 0.10 AND 0.90
    """
    params = []
    if market:
        q += " AND market = ?"
        params.append(market)
    q += " ORDER BY ts ASC"

    rows = con.execute(q, params).fetchall()
    con.close()

    if not rows:
        return None, []

    bankroll = budget
    wins = losses = bets = 0
    peak = budget
    max_dd = 0.0
    history = []

    for r in rows:
        if bankroll <= 0:
            break
        s  = min(bet, bankroll)
        bp = r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])
        bp = max(0.01, min(0.99, bp))
        payout = 1.0 / bp
        bets += 1

        if r["correct"] == 1:
            bankroll += s * (payout - 1)
            wins += 1
        else:
            bankroll -= s
            losses += 1

        if bankroll > peak:
            peak = bankroll
        dd = (peak - bankroll) / peak * 100
        if dd > max_dd:
            max_dd = dd

        history.append((r["ts"][:16], round(bankroll, 2), r["correct"]))

    win_rate   = wins / bets * 100 if bets else 0
    roi        = (bankroll - budget) / budget * 100
    pnl        = bankroll - budget
    avg_payout = sum(
        1.0 / max(0.01, min(0.99, r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])))
        for r in rows
    ) / len(rows)

    return {
        "bets": bets, "wins": wins, "losses": losses,
        "win_rate": win_rate, "bankroll": bankroll,
        "pnl": pnl, "roi": roi, "max_dd": max_dd,
        "avg_payout": avg_payout, "rows": rows,
    }, history


def print_detail(label, r, history, budget=100.0, bet=1.0):
    if not r:
        print(f"\n  {label}: brak danych live\n")
        return

    status = "✅" if r["roi"] > 0 else "❌"
    print(f"""
{'━'*66}
  {status}  RYNEK: {label}
{'━'*66}

  Liczba transakcji:   {r['bets']}
  Wygrane:             {r['wins']}  ({r['win_rate']:.1f}%)
  Przegrane:           {r['losses']}
  Postawione łącznie:  ${r['bets'] * bet:.2f}

  Końcowy bankroll:    ${r['bankroll']:.2f}
  Zysk / Strata:       ${r['pnl']:+.2f}  ({r['roi']:+.1f}% ROI)
  Maks. drawdown:      {r['max_dd']:.1f}%
  Śr. payout:          {r['avg_payout']:.2f}x
""")

    # Projekcja
    if r["bets"] > 0:
        avg_per = r["pnl"] / r["bets"]
        per_day = 12 * 16  # 12 scanów/h × 16h (jeden rynek)
        print(f"  📈  Projekcja (1 rynek, $1/trade, {per_day} tradów/dzień):")
        print(f"      Dzienny:     ${avg_per * per_day:+.2f}")
        print(f"      Tygodniowy:  ${avg_per * per_day * 7:+.2f}")
        print(f"      Miesięczny:  ${avg_per * per_day * 30:+.2f}")
        print()

    # Scenariusze stawek
    print(f"  📊  Porównanie stawek:")
    for stake in [0.5, 1.0, 2.0, 5.0]:
        if stake > budget:
            continue
        b2 = budget
        for row in r["rows"]:
            if b2 <= 0:
                break
            s2  = min(stake, b2)
            bp2 = row["yes_price"] if row["direction"] == "UP" else (1.0 - row["yes_price"])
            bp2 = max(0.01, min(0.99, bp2))
            if row["correct"] == 1:
                b2 += s2 * (1.0 / bp2 - 1)
            else:
                b2 -= s2
        print(f"      ${stake:.1f}/trade → ${b2:.2f}  ({b2-budget:+.2f})")

    # Ostatnie 10
    print(f"\n  📋  Ostatnie 10 transakcji:")
    print(f"  {'Czas':<18} {'Bankroll':>10}  Wynik")
    print(f"  {'─'*18} {'─'*10}  {'─'*5}")
    for ts, bk, correct in history[-10:]:
        result = "WIN ✅" if correct == 1 else "LOSS ❌"
        print(f"  {ts:<18} ${bk:>9.2f}  {result}")


def main():
    print(f"""
╔══════════════════════════════════════════════════════════════════════╗
║      KRONOS — RAPORT WSZYSTKICH RYNKÓW  (tylko dane POLY live)      ║
║      Budżet: $100  |  Stawka: $1/trade  |  Flat bet                 ║
╚══════════════════════════════════════════════════════════════════════╝
""")

    # ── Tabela podsumowania ────────────────────────────────────────────────
    print(f"  {'RYNEK':<22} {'TRADES':>7} {'WIN%':>6} {'PNL':>9} {'ROI':>8} {'DD':>6} {'PAY':>6}")
    print(f"  {'─'*22} {'─'*7} {'─'*6} {'─'*9} {'─'*8} {'─'*6} {'─'*6}")

    results = {}
    histories = {}

    for mkt in MARKETS:
        r, hist = simulate(mkt)
        results[mkt]   = r
        histories[mkt] = hist
        if not r:
            print(f"  {'?'} {mkt:<20} {'brak':>7}")
            continue
        s = "✅" if r["roi"] > 0 else "❌"
        print(f"  {s} {mkt:<20} {r['bets']:>7} {r['win_rate']:>5.1f}% "
              f"${r['pnl']:>+8.2f} {r['roi']:>+7.1f}% {r['max_dd']:>5.1f}% {r['avg_payout']:>5.2f}x")

    all_r, all_h = simulate(None)
    if all_r:
        print(f"  {'─'*22} {'─'*7} {'─'*6} {'─'*9} {'─'*8} {'─'*6} {'─'*6}")
        print(f"  {'  ŁĄCZNIE':<22} {all_r['bets']:>7} {all_r['win_rate']:>5.1f}% "
              f"${all_r['pnl']:>+8.2f} {all_r['roi']:>+7.1f}% {all_r['max_dd']:>5.1f}%")

    # ── Szczegóły per rynek ────────────────────────────────────────────────
    for mkt in MARKETS:
        print_detail(mkt, results[mkt], histories[mkt])

    # ── Szczegóły łącznie ─────────────────────────────────────────────────
    print_detail("WSZYSTKIE RYNKI ŁĄCZNIE", all_r, all_h)

    total = all_r["bets"] if all_r else 0
    print(f"  ⚠️  Próbka: {total} transakcji live. Minimum wiarygodne = 200/rynek.")
    print(f"  ⚠️  Projekcja wiarygodna dopiero po 200+ trade/rynek.\n")


if __name__ == "__main__":
    main()
