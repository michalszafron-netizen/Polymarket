"""
KRONOS — Symulacja zysku przy flat bet $1 na każdą predykcję.

Użycie:
  python backtest/simulate.py
  python backtest/simulate.py --budget 100 --bet 1 --gate 0.50 --market "BTC 5-Min Up/Down"
"""

import sqlite3
import argparse
from pathlib import Path

DB = Path(__file__).parent.parent / "kronos.db"

def run(budget=100.0, bet=1.0, conf_gate=0.50, conf_max=1.0, market=None):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    # Prawdziwe ceny POLY, w rozsądnym zakresie (0.10-0.90 = rynek jeszcze otwarty)
    q = """
        SELECT direction, confidence, yes_price, ev, correct, ts, market
        FROM edges
        WHERE resolved = 1
          AND confidence >= ?
          AND confidence <= ?
          AND ABS(yes_price - 0.51) > 0.005
          AND yes_price BETWEEN 0.10 AND 0.90
    """
    params = [conf_gate, conf_max]

    if market:
        q += " AND market = ?"
        params.append(market)

    q += " ORDER BY ts ASC"
    rows = con.execute(q, params).fetchall()
    con.close()

    if not rows:
        print("Brak danych spełniających kryteria.")
        return

    bankroll   = budget
    bets       = 0
    wins       = 0
    losses     = 0
    peak       = budget
    max_dd     = 0.0
    total_wagered = 0.0
    history    = []   # (ts, bankroll)
    ev_sum     = 0.0

    for r in rows:
        if bankroll <= 0:
            break

        actual_bet = min(bet, bankroll)
        # UP → kupujemy YES za yes_price, DOWN → kupujemy NO za (1 - yes_price)
        bet_price  = r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])
        bet_price  = max(0.01, min(0.99, bet_price))  # zabezpieczenie
        payout     = 1.0 / bet_price
        bets      += 1
        total_wagered += actual_bet
        ev_sum    += r["ev"]

        if r["correct"] == 1:
            profit   = actual_bet * (payout - 1)
            bankroll += profit
            wins     += 1
        else:
            bankroll -= actual_bet
            losses   += 1

        if bankroll > peak:
            peak = bankroll
        dd = (peak - bankroll) / peak * 100
        if dd > max_dd:
            max_dd = dd

        history.append((r["ts"][:16], round(bankroll, 2)))

    # ── Statystyki ──────────────────────────────────────────────────────────
    net_pnl   = bankroll - budget
    roi       = net_pnl / budget * 100
    win_rate  = wins / bets * 100 if bets else 0
    avg_ev    = ev_sum / bets * 100 if bets else 0
    per_hour  = bets / max(1, (len(rows) / 4)) * 60 / 5  # ~4 rynki co 5 min

    mkt_label = market or "WSZYSTKIE RYNKI"

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║         KRONOS — SYMULACJA FLAT BET                         ║
╚══════════════════════════════════════════════════════════════╝

  Rynek:          {mkt_label}
  Budżet:         ${budget:.2f}
  Stawka/trade:   ${bet:.2f}  ({bet/budget*100:.1f}% budżetu)
  Min. confidence:{conf_gate*100:.0f}%  Max: {conf_max*100:.0f}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Liczba transakcji:   {bets}
  Wygrane:             {wins}  ({win_rate:.1f}%)
  Przegrane:           {losses}
  Postawione łącznie:  ${total_wagered:.2f}

  Końcowy bankroll:    ${bankroll:.2f}
  Zysk / Strata:       ${net_pnl:+.2f}  ({roi:+.1f}% ROI)
  Maks. drawdown:      {max_dd:.1f}%
  Śr. EV na trade:     {avg_ev:.1f}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
""")

    # ── Projekcja dzienna / miesięczna ───────────────────────────────────────
    if bets > 0:
        avg_pnl_per_bet = net_pnl / bets
        bets_per_hour   = 4 * (60 / 5)          # 4 rynki × 12 razy/h
        bets_per_day    = bets_per_hour * 16     # 16h aktywnego handlu

        proj_day   = avg_pnl_per_bet * bets_per_day
        proj_week  = proj_day * 7
        proj_month = proj_day * 30

        print(f"""  📈  PROJEKCJA (przy ${bet:.0f}/trade, {bets_per_day:.0f} transakcji/dzień):
      Dzienny zysk:    ${proj_day:+.2f}
      Tygodniowy:      ${proj_week:+.2f}
      Miesięczny:      ${proj_month:+.2f}
""")

    # ── Scenariusze porównawcze ───────────────────────────────────────────────
    print("  📊  PORÓWNANIE SCENARIUSZY (przy aktualnym win rate):\n")
    for stake in [0.5, 1.0, 2.0, 5.0]:
        if stake > budget:
            continue
        b2 = budget
        for r in rows:
            if b2 <= 0: break
            s2  = min(stake, b2)
            bp2 = r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])
            bp2 = max(0.01, min(0.99, bp2))
            p2  = 1.0 / bp2
            if r["correct"] == 1:
                b2 += s2 * (p2 - 1)
            else:
                b2 -= s2
        pnl2 = b2 - budget
        print(f"    Stawka ${stake:.1f}/trade → końcowy bankroll: ${b2:.2f}  ({pnl2:+.2f})")

    # ── Ostatnie 10 transakcji ────────────────────────────────────────────────
    print(f"\n  📋  Ostatnie 10 transakcji:\n")
    print(f"  {'Czas':<17} {'Bankroll':>10}")
    print(f"  {'─'*17} {'─'*10}")
    for ts, bk in history[-10:]:
        delta = bk - (history[-11][1] if len(history) > 10 else budget)
        arrow = "▲" if delta >= 0 else "▼"
        print(f"  {ts:<17} ${bk:>9.2f}  {arrow} ${abs(delta):.2f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--budget",  type=float, default=100.0)
    p.add_argument("--bet",     type=float, default=1.0)
    p.add_argument("--gate",    type=float, default=0.50,  help="Min confidence (0-1)")
    p.add_argument("--maxconf", type=float, default=1.0,   help="Max confidence (0-1)")
    p.add_argument("--market",  type=str,   default=None)
    args = p.parse_args()

    run(
        budget   = args.budget,
        bet      = args.bet,
        conf_gate= args.gate,
        conf_max = args.maxconf,
        market   = args.market,
    )
