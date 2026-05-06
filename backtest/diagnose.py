"""Diagnostyka cen yes_price per rynek — sprawdza czy dane są sensowne."""
import sqlite3
from pathlib import Path

DB = Path(__file__).parent.parent / "kronos.db"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

MARKETS = [
    "BTC 5-Min Up/Down",
    "ETH 5-Min Up/Down",
    "BTC 15-Min Up/Down",
    "ETH 15-Min Up/Down",
]

for mkt in MARKETS:
    rows = con.execute("""
        SELECT yes_price, direction, correct, ts
        FROM edges
        WHERE market = ? AND ABS(yes_price - 0.51) > 0.005 AND resolved = 1
        ORDER BY ts DESC LIMIT 20
    """, [mkt]).fetchall()

    if not rows:
        print(f"\n{mkt}: BRAK danych POLY live")
        continue

    prices = [r["yes_price"] for r in rows]
    bet_prices = [
        r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])
        for r in rows
    ]

    print(f"\n{'─'*60}")
    print(f"  {mkt}  ({len(rows)} ostatnich transakcji)")
    print(f"  yes_price:  min={min(prices):.3f}  max={max(prices):.3f}  avg={sum(prices)/len(prices):.3f}")
    print(f"  bet_price:  min={min(bet_prices):.3f}  max={max(bet_prices):.3f}  avg={sum(bet_prices)/len(bet_prices):.3f}")
    print(f"  avg payout: {sum(1/p for p in bet_prices)/len(bet_prices):.2f}x")
    print(f"\n  {'Czas':<18} {'DIR':<5} {'YES_P':>6} {'BET_P':>6} {'PAY':>6} {'OK'}")
    for r in rows[:10]:
        bp = r["yes_price"] if r["direction"] == "UP" else (1.0 - r["yes_price"])
        ok = "✅" if r["correct"] == 1 else "❌"
        flag = " ⚠️ NISKA" if bp < 0.15 else ""
        print(f"  {r['ts'][:18]:<18} {r['direction']:<5} {r['yes_price']:>6.3f} {bp:>6.3f} {1/bp:>6.2f}x {ok}{flag}")

con.close()
