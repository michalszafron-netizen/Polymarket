"""
KRONOS SIGNAL CORRELATION — correlate_signals.py

Cel: Sprawdzić czy sygnały z dwóch niezależnych źródeł (Chronos AI + Lag Monitor)
są ze sobą zgodne, i czy zgodność poprawia win rate.

Dla każdego edge'a z edges (predykcja Chronosa) znajduje najbliższą próbkę
z lag_log (spot vs Polymarket lag) w tym samym oknie czasowym.

Analiza:
  1. Win rate gdy OBA sygnały zgodne (UP + BUY_YES / DOWN + BUY_NO)
  2. Win rate gdy sygnały SPRZECZNE
  3. Win rate gdy tylko Chronos ma sygnał (lag = NONE)
  4. Rozkład lag w momencie scanu

Użycie:
    python research/correlate_signals.py
    python research/correlate_signals.py --market "BTC 5-Min Up/Down"
"""

import sqlite3
import argparse
from pathlib import Path
from datetime import datetime, timedelta

DB_PATH = Path(__file__).parent.parent / "kronos.db"

MARKETS = [
    "BTC 5-Min Up/Down",
    "ETH 5-Min Up/Down",
    "BTC 15-Min Up/Down",
    "ETH 15-Min Up/Down",
]


def correlate_market(market: str, con: sqlite3.Connection) -> dict | None:
    """
    Dla każdego edge'a znajduje najbliższą próbkę lag_log (<= 5s różnicy)
    i sprawdza zgodność sygnałów.
    """
    # Pobierz wszystkie rozwiązane edge'e dla tego rynku
    edges = con.execute(
        """
        SELECT id, ts, direction, confidence, correct
        FROM edges
        WHERE market = ? AND resolved = 1
          AND ABS(yes_price - 0.51) > 0.005
          AND yes_price BETWEEN 0.10 AND 0.90
        ORDER BY ts ASC
        """,
        (market,),
    ).fetchall()

    if len(edges) < 10:
        return None

    total = len(edges)
    agree = 0       # Chronos i lag zgodne
    disagree = 0    # Chronos i lag sprzeczne
    lag_only = 0    # Tylko lag miał sygnał (N/A — edge już ma kierunek)
    no_lag = 0      # Lag monitor nie miał sygnału (NONE)

    agree_wins = 0
    disagree_wins = 0
    no_lag_wins = 0

    examples_agree: list[dict] = []
    examples_disagree: list[dict] = []

    for edge in edges:
        edge_id, ts, direction, confidence, correct = edge

        # Parsuj timestamp edge'a
        try:
            edge_dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S")
        except ValueError:
            try:
                edge_dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue

        # Szukaj najbliższej próbki lag_log w oknie +/- 10s
        t_min = (edge_dt - timedelta(seconds=10)).strftime("%Y-%m-%d %H:%M:%S")
        t_max = (edge_dt + timedelta(seconds=10)).strftime("%Y-%m-%d %H:%M:%S")

        lag_row = con.execute(
            """
            SELECT signal, lag_pct, spot_change_pct, poly_yes, fair_yes, window_sec_in
            FROM lag_log
            WHERE market = ?
              AND ts >= ? AND ts <= ?
              AND poly_yes IS NOT NULL
            ORDER BY ABS(
              (julianday(ts) - julianday(?)) * 86400
            ) ASC
            LIMIT 1
            """,
            (market, t_min, t_max, ts),
        ).fetchone()

        if lag_row is None:
            no_lag += 1
            if correct == 1:
                no_lag_wins += 1
            continue

        lag_signal, lag_pct, spot_pct, poly_yes, fair_yes, win_sec = lag_row

        if lag_signal == "NONE":
            no_lag += 1
            if correct == 1:
                no_lag_wins += 1
            continue

        # Sprawdź zgodność: UP ↔ BUY_YES, DOWN ↔ BUY_NO
        chronos_up = direction == "UP"
        lag_buy_yes = lag_signal == "BUY_YES"

        is_agree = chronos_up == lag_buy_yes

        if is_agree:
            agree += 1
            if correct == 1:
                agree_wins += 1
            examples_agree.append({
                "ts": ts,
                "direction": direction,
                "lag_signal": lag_signal,
                "lag_pct": lag_pct,
                "spot_pct": spot_pct,
                "confidence": confidence,
                "correct": correct,
            })
        else:
            disagree += 1
            if correct == 1:
                disagree_wins += 1
            examples_disagree.append({
                "ts": ts,
                "direction": direction,
                "lag_signal": lag_signal,
                "lag_pct": lag_pct,
                "spot_pct": spot_pct,
                "confidence": confidence,
                "correct": correct,
            })

    agree_wr = (agree_wins / agree * 100) if agree > 0 else 0
    disagree_wr = (disagree_wins / disagree * 100) if disagree > 0 else 0
    no_lag_wr = (no_lag_wins / no_lag * 100) if no_lag > 0 else 0

    return {
        "market": market,
        "total": total,
        "agree": agree,
        "disagree": disagree,
        "no_lag": no_lag,
        "agree_wr": agree_wr,
        "disagree_wr": disagree_wr,
        "no_lag_wr": no_lag_wr,
        "agree_wins": agree_wins,
        "disagree_wins": disagree_wins,
        "no_lag_wins": no_lag_wins,
        "examples_agree": examples_agree[:5],
        "examples_disagree": examples_disagree[:5],
    }


def main():
    parser = argparse.ArgumentParser(description="Korelacja sygnałów Chronos vs Lag Monitor")
    parser.add_argument("--market", default=None)
    args = parser.parse_args()

    print(f"\n{'═' * 72}")
    print(f"  KRONOS SIGNAL CORRELATION — Chronos AI vs Lag Monitor")
    print(f"  Dane: {DB_PATH}")
    print(f"{'═' * 72}\n")

    con = sqlite3.connect(DB_PATH)
    targets = [args.market] if args.market else MARKETS
    all_results = []

    for mkt in targets:
        r = correlate_market(mkt, con)
        if r:
            all_results.append(r)

    con.close()

    if not all_results:
        print("  ❌ Brak danych do korelacji. Potrzeba minimum 10 resolved edges/rynek.\n")
        return

    # ─── Tabela wyników ────────────────────────────────────────────────────
    print(f"  {'Rynek':<22} {'Total':>6} {'Zgodne':>7} {'WR zg':>7} {'Sprzeczne':>10} {'WR sprz':>8} {'Brak lag':>9} {'WR brak':>8}")
    print(f"  {'─'*22} {'─'*6} {'─'*7} {'─'*7} {'─'*10} {'─'*8} {'─'*9} {'─'*8}")

    total_agree = total_disagree = total_no_lag = 0
    total_agree_wins = total_disagree_wins = total_no_lag_wins = 0

    for r in all_results:
        best = "✅ ZGODNE" if r["agree_wr"] > r["disagree_wr"] else "❌ SPRZECZNE"
        print(
            f"  {r['market']:<22} {r['total']:>6} "
            f"{r['agree']:>7} {r['agree_wr']:>6.1f}% "
            f"{r['disagree']:>10} {r['disagree_wr']:>7.1f}% "
            f"{r['no_lag']:>9} {r['no_lag_wr']:>7.1f}%  {best}"
        )
        total_agree += r["agree"]
        total_disagree += r["disagree"]
        total_no_lag += r["no_lag"]
        total_agree_wins += r["agree_wins"]
        total_disagree_wins += r["disagree_wins"]
        total_no_lag_wins += r["no_lag_wins"]

    # ─── Łącznie ────────────────────────────────────────────────────────────
    all_agree_wr = (total_agree_wins / total_agree * 100) if total_agree > 0 else 0
    all_disagree_wr = (total_disagree_wins / total_disagree * 100) if total_disagree > 0 else 0
    all_no_lag_wr = (total_no_lag_wins / total_no_lag * 100) if total_no_lag > 0 else 0

    print(f"  {'─'*22} {'─'*6} {'─'*7} {'─'*7} {'─'*10} {'─'*8} {'─'*9} {'─'*8}")
    print(
        f"  {'ŁĄCZNIE':<22} {'':>6} "
        f"{total_agree:>7} {all_agree_wr:>6.1f}% "
        f"{total_disagree:>10} {all_disagree_wr:>7.1f}% "
        f"{total_no_lag:>9} {all_no_lag_wr:>7.1f}%"
    )

    # ─── Wnioski ────────────────────────────────────────────────────────────
    print(f"\n  {'═' * 72}")
    print(f"  📊 WNIOSKI:")
    print(f"  {'═' * 72}")

    if all_agree_wr > all_disagree_wr + 5:
        diff = all_agree_wr - all_disagree_wr
        print(f"\n  ✅ Zgodność sygnałów ma WYŻSZY win rate: +{diff:.1f}pp")
        print(f"     Gdy Chronos i Lag Monitor są zgodne → lepsza trafność")
        print(f"     Rekomendacja: wchodź TYLKO gdy oba sygnały zgodne")
    elif all_disagree_wr > all_agree_wr + 5:
        diff = all_disagree_wr - all_agree_wr
        print(f"\n  ⚠️  Sprzeczność sygnałów ma WYŻSZY win rate: +{diff:.1f}pp")
        print(f"     Gdy Lag Monitor mówi przeciwnie niż Chronos → Chronos ma rację")
        print(f"     Rekomendacja: ignoruj Lag Monitor dla Chronosa, użyj do innej strategii")
    else:
        print(f"\n  📊 Brak istotnej różnicy w win rate między zgodnością a sprzecznością")
        print(f"     Zgodne: {all_agree_wr:.1f}% | Sprzeczne: {all_disagree_wr:.1f}%")
        print(f"     Lag Monitor i Chronos mierzą inne zjawiska — nie korelują")

    print(f"\n  {'═' * 72}\n")


if __name__ == "__main__":
    main()