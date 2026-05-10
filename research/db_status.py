"""KRONOS DB Status — szybki podgląd bazy"""
import sqlite3
from pathlib import Path

DB = Path(__file__).parent.parent / "kronos.db"
con = sqlite3.connect(DB)

print("=" * 60)
print("  KRONOS DB STATUS")
print("=" * 60)

# edges
e = con.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
e_res = con.execute("SELECT COUNT(*) FROM edges WHERE resolved=1").fetchone()[0]
e_correct = con.execute("SELECT COUNT(*) FROM edges WHERE resolved=1 AND correct=1").fetchone()[0]
e_min, e_max = con.execute("SELECT MIN(ts), MAX(ts) FROM edges").fetchone()
wr = round(e_correct / e_res * 100, 1) if e_res > 0 else 0
print(f"\nedges:       {e} total, {e_res} resolved, {e_correct} correct ({wr}%)")
print(f"  zakres:    {e_min} → {e_max}")

# per market
print(f"\n  {'Market':<22} {'Total':>7} {'Resolved':>9} {'Correct':>8} {'WR':>6}")
print(f"  {'-'*22} {'-'*7} {'-'*9} {'-'*8} {'-'*6}")
for row in con.execute("SELECT market, COUNT(*), SUM(CASE WHEN resolved=1 THEN 1 ELSE 0 END), SUM(CASE WHEN resolved=1 AND correct=1 THEN 1 ELSE 0 END) FROM edges GROUP BY market ORDER BY market").fetchall():
    m, t, r, c = row
    wr_m = round(c / r * 100, 1) if r > 0 else 0
    print(f"  {m:<22} {t:>7} {r:>9} {c:>8} {wr_m:>5.1f}%")

# lag_log
l = con.execute("SELECT COUNT(*) FROM lag_log").fetchone()[0]
l_min, l_max = con.execute("SELECT MIN(ts), MAX(ts) FROM lag_log").fetchone()
print(f"\nlag_log:     {l} total")
print(f"  zakres:    {l_min} → {l_max}")

# lag signals
for row in con.execute("SELECT market, signal, COUNT(*) FROM lag_log WHERE signal != 'NONE' GROUP BY market, signal ORDER BY market, signal").fetchall():
    print(f"  SIGNAL {row[0]:<22} {row[1]:<10} {row[2]:>7}")

con.close()
