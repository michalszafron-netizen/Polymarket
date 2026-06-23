"""
KRONOS Edge #3 — Polymarket BTC/ETH daily strike-ladder vs Deribit options-implied distribution.

Polymarket "Bitcoin price on <date>" markets: 11 buckets of $2k width covering
spot +-18k, resolving at a fixed UTC timestamp ~7 days out. Each bucket's YES
price is the market's P(price in that bucket).

Deribit publishes mark_iv (implied vol) per strike per expiry. Under Black-76
(forward measure), the risk-neutral P(S_T > K) = N(d2) where
  d2 = (ln(F/K) - 0.5*sigma^2*T) / (sigma*sqrt(T))
F = forward/underlying price Deribit uses for that expiry, T = years to expiry.

We build both CDFs at the Polymarket bucket boundaries and compare.
Edge thesis: retail mispricing on Polymarket strike ladder vs options-implied
distribution, large enough to survive Polymarket's spread (held to resolution,
no intraday exit needed).
"""
import requests
from scipy.stats import norm
from datetime import datetime, timezone
import math

GAMMA = "https://gamma-api.polymarket.com"
DERIBIT = "https://www.deribit.com/api/v2"


def get_polymarket_ladder(slug: str):
    r = requests.get(f"{GAMMA}/events", params={"slug": slug}, timeout=10)
    events = r.json()
    if not events:
        return None
    ev = events[0]
    buckets = []
    for m in ev["markets"]:
        q = m["question"]
        prices = m.get("outcomePrices")
        if isinstance(prices, str):
            import json
            prices = json.loads(prices)
        yes_price = float(prices[0])
        lo, hi = parse_bucket(q)
        buckets.append({"lo": lo, "hi": hi, "yes": yes_price, "question": q})
    buckets.sort(key=lambda b: (b["lo"] if b["lo"] is not None else -1))
    return {"end_date": ev["endDate"], "buckets": buckets, "title": ev["title"]}


def parse_bucket(question: str):
    """Extract (lo, hi) price bounds from a Polymarket bucket question. hi=None means open-ended above."""
    q = question.replace(",", "").replace("$", "")
    if "between" in q:
        nums = [float(x) for x in q.split() if x.replace(".", "").isdigit()]
        return nums[0], nums[1]
    if "less than" in q:
        nums = [float(x) for x in q.split() if x.replace(".", "").isdigit()]
        return None, nums[0]
    if "greater than" in q:
        nums = [float(x) for x in q.split() if x.replace(".", "").isdigit()]
        return nums[0], None
    raise ValueError(f"cannot parse bucket: {question}")


def polymarket_cdf_above(ladder, K):
    """P(price > K) per Polymarket = sum of YES prices of buckets entirely above K."""
    total = 0.0
    for b in ladder["buckets"]:
        lo = b["lo"] if b["lo"] is not None else -1e18
        if lo >= K - 1e-6:
            total += b["yes"]
    return total


def get_deribit_chain(currency: str, expiry_code: str):
    r = requests.get(f"{DERIBIT}/public/get_instruments", params={
        "currency": currency, "kind": "option", "expired": "false"
    }, timeout=10)
    instruments = r.json()["result"]
    matched = [i for i in instruments if i["instrument_name"].split("-")[1] == expiry_code]
    chain = []
    for inst in matched:
        name = inst["instrument_name"]
        parts = name.split("-")
        strike = float(parts[2])
        opt_type = parts[3]  # C or P
        tr = requests.get(f"{DERIBIT}/public/ticker", params={"instrument_name": name}, timeout=10)
        t = tr.json().get("result")
        if not t or t.get("mark_iv") is None:
            continue
        chain.append({
            "strike": strike, "type": opt_type,
            "mark_iv": t["mark_iv"] / 100.0,
            "underlying_price": t["underlying_price"],
            "expiration_timestamp": inst["expiration_timestamp"],
        })
    return chain


def deribit_prob_above(chain, K, resolve_dt: datetime):
    """Interpolate IV at strike K (using nearest calls), compute N(d2) using actual
    time-to-Polymarket-resolution (not Deribit's own expiry time)."""
    calls = sorted([c for c in chain if c["type"] == "C"], key=lambda c: c["strike"])
    if not calls:
        return None
    # find IV at K via linear interpolation across strikes
    strikes = [c["strike"] for c in calls]
    ivs = [c["mark_iv"] for c in calls]
    F = calls[0]["underlying_price"]  # forward/underlying Deribit uses, same for all strikes same expiry

    if K <= strikes[0]:
        iv = ivs[0]
    elif K >= strikes[-1]:
        iv = ivs[-1]
    else:
        for i in range(len(strikes) - 1):
            if strikes[i] <= K <= strikes[i + 1]:
                w = (K - strikes[i]) / (strikes[i + 1] - strikes[i])
                iv = ivs[i] * (1 - w) + ivs[i + 1] * w
                break

    now = datetime.now(timezone.utc)
    T = (resolve_dt - now).total_seconds() / (365.25 * 24 * 3600)
    if T <= 0 or iv <= 0:
        return None
    d2 = (math.log(F / K) - 0.5 * iv * iv * T) / (iv * math.sqrt(T))
    return norm.cdf(d2), iv, F, T


def main():
    targets = [
        ("bitcoin-price-on-june-25-2026", "BTC", "25JUN26"),
        ("bitcoin-price-on-june-26-2026", "BTC", "26JUN26"),
        ("ethereum-price-on-june-25-2026", "ETH", "25JUN26"),
    ]

    for slug, currency, expiry_code in targets:
        print(f"\n{'='*90}\n{slug}  (Deribit expiry {expiry_code})\n{'='*90}")
        ladder = get_polymarket_ladder(slug)
        if not ladder:
            print("  Polymarket event not found — skip")
            continue
        resolve_dt = datetime.fromisoformat(ladder["end_date"].replace("Z", "+00:00"))
        chain = get_deribit_chain(currency, expiry_code)
        if not chain:
            print("  Deribit chain empty — skip")
            continue

        print(f"  {'Strike K':>10} {'PM P(>K)':>10} {'Deribit P(>K)':>14} {'Gap(pp)':>9} {'IV used':>8}")
        boundaries = sorted({b["lo"] for b in ladder["buckets"] if b["lo"] is not None} |
                             {b["hi"] for b in ladder["buckets"] if b["hi"] is not None})
        for K in boundaries:
            pm_p = polymarket_cdf_above(ladder, K)
            db = deribit_prob_above(chain, K, resolve_dt)
            if db is None:
                continue
            db_p, iv, F, T = db
            gap = (pm_p - db_p) * 100
            flag = "  <-- PM CHEAP (buy YES>K)" if gap < -5 else ("  <-- PM RICH (buy NO/sell)" if gap > 5 else "")
            print(f"  {K:>10.0f} {pm_p*100:>9.2f}% {db_p*100:>13.2f}% {gap:>+8.2f} {iv*100:>7.1f}%{flag}")
        print(f"  (forward F={chain[0]['underlying_price']:.0f}, resolve={resolve_dt})")


if __name__ == "__main__":
    main()
