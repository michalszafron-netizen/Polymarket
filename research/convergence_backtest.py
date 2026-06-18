"""
KRONOS Edge #1 — Near-expiry convergence backtest.

Ground truth: a window's resolution price == the NEXT window's spot_open
(verified empirically). outcome_up = resolution_price > spot_open.

We test: near expiry, if we bet on the side matching the sign of the current
displacement (continuation of an already-established move), buying the
"favorite" at the logged poly_yes price, what is the realized win rate and EV?
We report EV at poly_yes AND at poly_yes + assumed spread, because the spread
is what decides whether the edge survives.
"""
import sqlite3, math
from collections import defaultdict

con = sqlite3.connect('kronos.db')
cur = con.cursor()

MARKETS = ['BTC 5-Min Up/Down', 'ETH 5-Min Up/Down',
           'BTC 15-Min Up/Down', 'ETH 15-Min Up/Down']

def build_windows(market, interval_min):
    """Return list of (open_epoch, spot_open) sorted, plus a dict snapshot rows."""
    rows = cur.execute("""
        SELECT ts, window_sec_in, spot_open, spot_now, poly_yes
        FROM lag_log WHERE market=? ORDER BY ts
    """, (market,)).fetchall()
    # group snapshots by window_open key
    wins = defaultdict(list)   # open_key -> list of (sec_in, spot_open, spot_now, poly_yes, ts)
    import datetime
    for ts, sec_in, so, sn, py in rows:
        if so is None or sn is None:
            continue
        t = datetime.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S')
        open_epoch = t.timestamp() - sec_in
        open_key = round(open_epoch / 60.0) * 60  # snap to minute boundary
        wins[open_key].append((sec_in, so, sn, py))
    return wins

def analyze(market, interval_min):
    wins = build_windows(market, interval_min)
    keys = sorted(wins.keys())
    # resolution price for window k = spot_open of next window (k+1)
    # use the spot_open recorded for the next window
    open_price = {}
    for k in keys:
        # spot_open within a window should be constant; take the first
        open_price[k] = wins[k][0][1]

    horizon = interval_min * 60
    results = []  # one per usable snapshot near expiry
    for i, k in enumerate(keys[:-1]):
        nxt = keys[i+1]
        # only chain if next window opens ~horizon seconds later (consecutive)
        if abs((nxt - k) - horizon) > 90:
            continue
        so = open_price[k]
        res_price = open_price[nxt]
        if so is None or res_price is None:
            continue
        outcome_up = 1 if res_price > so else 0
        for sec_in, so2, sn, py in wins[k]:
            tau = horizon - sec_in
            if tau < 5 or tau > 75:    # near-expiry window only
                continue
            if py is None:
                continue
            d = sn / so - 1.0          # displacement
            results.append((tau, d, py, outcome_up))
    return results

def ev_report(name, results, spreads=(0.0, 0.02, 0.03)):
    print(f"\n===== {name}  (n_snapshots near-expiry = {len(results)}) =====")
    # Strategy: bet on continuation side (sign of d). Buy favorite.
    # entry price: if d>0 bet YES at py ; if d<0 bet NO at (1-py)
    # win if outcome matches bet.
    for min_entry, max_entry in [(0.80,0.97),(0.85,0.97),(0.90,0.98)]:
        for tau_max in [30, 45, 60]:
            picks = []
            for tau, d, py, up in results:
                if tau > tau_max:
                    continue
                if d > 0:
                    entry = py; win = up
                elif d < 0:
                    entry = 1 - py; win = 1 - up
                else:
                    continue
                if entry < min_entry or entry > max_entry:
                    continue
                picks.append((entry, win))
            if len(picks) < 100:
                continue
            n = len(picks)
            wr = sum(w for _, w in picks) / n
            avg_entry = sum(e for e, _ in picks) / n
            line = f"entry[{min_entry:.2f}-{max_entry:.2f}] tau<={tau_max:>2}s  n={n:>5}  WR={wr*100:5.1f}%  avg_entry={avg_entry:.3f}"
            for sp in spreads:
                # EV per unit cost = mean( win/(entry+sp) ) - 1   (pay spread on entry)
                ev = sum( (w / (e + sp)) for e, w in picks)/n - 1
                line += f"  | EV@+{sp:.2f}={ev*100:+5.1f}%"
            print(line)

def calibration(name, results):
    """Is poly_yes itself calibrated near expiry? bin by py, show actual P(up)."""
    print(f"\n--- poly_yes calibration near expiry: {name} ---")
    bins = defaultdict(lambda: [0,0])
    for tau, d, py, up in results:
        b = round(py*10)/10
        bins[b][0]+=up; bins[b][1]+=1
    for b in sorted(bins):
        s,c = bins[b]
        print(f"  poly_yes~{b:.1f}  n={c:>5}  actual_P(up)={s/c*100:5.1f}%")

for m in MARKETS:
    iv = 5 if '5-Min' in m else 15
    res = analyze(m, iv)
    calibration(m, res)
    ev_report(m, res)
