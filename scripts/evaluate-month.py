#!/usr/bin/env python3
"""
Monthly calibration evaluator for the rainfall probability tracker.

Fetches actual monthly precipitation from IEM, loads forecast snapshots,
and computes Brier scores and reliability diagrams for Ensemble, Market
(Kalshi), and Climatology (historical base rates).

Usage:
    python3 scripts/evaluate-month.py 2026-04
    python3 scripts/evaluate-month.py "April 2026"
    python3 scripts/evaluate-month.py 2026-04 --snapshots /path/to/snapshots.json

Snapshots can come from:
    - /tmp/forecast-snapshots.json (server-side)
    - A local export of browser localStorage (key: "rainfall-tracker-snapshots")
    - Any JSON file containing a ForecastSnapshot[] array

Output: public/data/calibration/{year}-{month}.json
"""

import argparse
import calendar
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

import numpy as np

# ---------------------------------------------------------------------------
# Station metadata (must match src/lib/stations.ts)
# ---------------------------------------------------------------------------

STATIONS = {
    "SFO": {"city": "San Francisco", "iem": "SFO"},
    "LAX": {"city": "Los Angeles",   "iem": "LAX"},
    "MIA": {"city": "Miami",         "iem": "MIA"},
    "DEN": {"city": "Denver",        "iem": "DEN"},
    "MDW": {"city": "Chicago",       "iem": "MDW"},
    "NYC": {"city": "New York",      "iem": "NYC"},
    "SEA": {"city": "Seattle",       "iem": "SEA"},
    "AUS": {"city": "Austin",        "iem": "AUS"},
    "DFW": {"city": "Dallas-FW",     "iem": "DFW"},
    "HOU": {"city": "Houston",       "iem": "HOU"},
}

THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]


# ---------------------------------------------------------------------------
# IEM actual precipitation fetching
# ---------------------------------------------------------------------------

def fetch_actual_monthly(station_code: str, year: int, month: int) -> float | None:
    """
    Fetch the actual total monthly precipitation for a station from IEM.

    Uses the CLI JSON endpoint and reads precip_month from the last
    available day of the target month.
    """
    iem_code = STATIONS[station_code]["iem"]
    url = f"https://mesonet.agron.iastate.edu/json/cli.py?station=K{iem_code}&year={year}"

    try:
        req = Request(url, headers={"User-Agent": "RainfallTracker-Calibration/1.0"})
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except (URLError, HTTPError, json.JSONDecodeError) as e:
        print(f"  [WARN] Failed to fetch IEM data for {station_code}: {e}")
        return None

    results = data.get("results", [])
    if not results:
        print(f"  [WARN] No IEM results for {station_code} year={year}")
        return None

    # Filter to target month, find latest day with precip_month
    best_date = None
    best_value = None

    for rec in results:
        valid = rec.get("valid", "")
        try:
            rec_date = datetime.strptime(valid, "%Y-%m-%d")
        except ValueError:
            continue

        if rec_date.year != year or rec_date.month != month:
            continue

        pm = rec.get("precip_month")
        if pm is None or pm == "M" or pm == "":
            continue

        try:
            val = float(pm)
        except (ValueError, TypeError):
            continue

        if best_date is None or rec_date > best_date:
            best_date = rec_date
            best_value = val

    if best_value is None:
        print(f"  [WARN] No precip_month data for {station_code} {year}-{month:02d}")

    return best_value


# ---------------------------------------------------------------------------
# Snapshot loading
# ---------------------------------------------------------------------------

def load_snapshots(path: str) -> list[dict]:
    """Load snapshots from a JSON file (array of ForecastSnapshot objects)."""
    with open(path, "r") as f:
        data = json.load(f)

    if isinstance(data, list):
        return data

    # Handle case where file wraps snapshots in an object
    if isinstance(data, dict) and "snapshots" in data:
        return data["snapshots"]

    raise ValueError(f"Unexpected snapshot format in {path}")


def load_base_rates(month: int) -> dict[str, dict[str, float]]:
    """
    Load historical base rates from historical-distributions.json.
    Returns { station_code: { "1.0": 0.75, "2.0": 0.45, ... } }
    """
    hist_path = os.path.join(
        os.path.dirname(__file__), "..", "public", "data", "historical-distributions.json"
    )
    hist_path = os.path.abspath(hist_path)

    with open(hist_path, "r") as f:
        hist = json.load(f)

    rates = {}
    month_key = str(month)

    for code in STATIONS:
        station_data = hist.get("stations", {}).get(code, {})
        month_data = station_data.get("months", {}).get(month_key, {})
        br = month_data.get("base_rates", {})
        rates[code] = {k: float(v) for k, v in br.items()}

    return rates


# ---------------------------------------------------------------------------
# Calibration metrics
# ---------------------------------------------------------------------------

def compute_brier_score(predictions: list[tuple[float, int]]) -> float | None:
    """
    Compute Brier score from list of (predicted_prob, actual_outcome) tuples.
    BS = mean((p - o)^2). Returns None if no predictions.
    """
    if not predictions:
        return None
    arr = np.array(predictions)
    return float(np.mean((arr[:, 0] - arr[:, 1]) ** 2))


def compute_reliability(
    predictions: list[tuple[float, int]], n_bins: int = 10
) -> list[dict]:
    """
    Bin predictions into deciles and compute observed frequency per bin.
    Returns list of { bin_start, bin_end, mean_predicted, mean_observed, count }.
    """
    if not predictions:
        return []

    bins = []
    for i in range(n_bins):
        lo = i / n_bins
        hi = (i + 1) / n_bins

        in_bin = [(p, o) for p, o in predictions if lo <= p < hi or (i == n_bins - 1 and p == hi)]

        if in_bin:
            arr = np.array(in_bin)
            bins.append({
                "bin_start": round(lo, 2),
                "bin_end": round(hi, 2),
                "mean_predicted": round(float(np.mean(arr[:, 0])), 4),
                "mean_observed": round(float(np.mean(arr[:, 1])), 4),
                "count": len(in_bin),
            })
        else:
            bins.append({
                "bin_start": round(lo, 2),
                "bin_end": round(hi, 2),
                "mean_predicted": None,
                "mean_observed": None,
                "count": 0,
            })

    return bins


# ---------------------------------------------------------------------------
# Main evaluation
# ---------------------------------------------------------------------------

def evaluate_month(year: int, month: int, snapshot_path: str) -> dict:
    month_str = f"{year}-{month:02d}"
    month_name = calendar.month_name[month]
    print(f"\n{'='*60}")
    print(f"Calibration evaluation: {month_name} {year}")
    print(f"{'='*60}")

    # 1. Fetch actual monthly totals
    print(f"\n--- Fetching actual precipitation from IEM ---")
    actuals: dict[str, float | None] = {}
    for code in STATIONS:
        print(f"  Fetching {code} ({STATIONS[code]['city']})...", end=" ")
        total = fetch_actual_monthly(code, year, month)
        actuals[code] = total
        if total is not None:
            print(f"{total:.2f}\"")
        else:
            print("MISSING")
        time.sleep(0.5)  # rate limit

    # 2. Compute exceedance outcomes
    outcomes: dict[str, dict[str, int]] = {}
    for code in STATIONS:
        outcomes[code] = {}
        if actuals[code] is not None:
            for t in THRESHOLDS:
                key = f"{t:.1f}"
                outcomes[code][key] = 1 if actuals[code] > t else 0

    # 3. Load snapshots
    print(f"\n--- Loading snapshots from {snapshot_path} ---")
    snapshots = load_snapshots(snapshot_path)
    print(f"  Loaded {len(snapshots)} snapshots")

    # Filter to snapshots from the target month
    month_snapshots = []
    for snap in snapshots:
        ts = snap.get("timestamp", "")
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if dt.year == year and dt.month == month:
                month_snapshots.append(snap)
        except (ValueError, AttributeError):
            continue

    print(f"  {len(month_snapshots)} snapshots from {month_name} {year}")
    if not month_snapshots:
        print("  [ERROR] No snapshots found for target month. Cannot compute calibration.")
        sys.exit(1)

    # 4. Load base rates for climatology baseline
    print(f"\n--- Loading historical base rates ---")
    base_rates = load_base_rates(month)

    # 5. Extract predictions from each snapshot
    # Three forecast sources: ensemble (combinedProb), market (kalshiPrices), climatology (base_rates)
    ensemble_preds: list[tuple[float, int]] = []    # (prob, outcome) global
    market_preds: list[tuple[float, int]] = []
    clim_preds: list[tuple[float, int]] = []

    ensemble_by_station: dict[str, list[tuple[float, int]]] = defaultdict(list)
    market_by_station: dict[str, list[tuple[float, int]]] = defaultdict(list)
    clim_by_station: dict[str, list[tuple[float, int]]] = defaultdict(list)

    for snap in month_snapshots:
        stations_data = snap.get("stations", {})
        for code in STATIONS:
            if actuals[code] is None:
                continue  # can't evaluate without ground truth

            st = stations_data.get(code)
            if not st:
                continue

            thresholds = st.get("thresholds", {})
            kalshi_prices = st.get("kalshiPrices", {})

            for t in THRESHOLDS:
                key = f"{t:.1f}"
                outcome = outcomes[code].get(key)
                if outcome is None:
                    continue

                # Ensemble: combinedProb
                tdata = thresholds.get(key)
                if tdata and tdata.get("combinedProb") is not None:
                    prob = float(tdata["combinedProb"])
                    prob = max(0.0, min(1.0, prob))
                    ensemble_preds.append((prob, outcome))
                    ensemble_by_station[code].append((prob, outcome))

                # Market: Kalshi mid-price (cents -> probability)
                if key in kalshi_prices and kalshi_prices[key] is not None:
                    market_prob = float(kalshi_prices[key]) / 100.0
                    market_prob = max(0.0, min(1.0, market_prob))
                    market_preds.append((market_prob, outcome))
                    market_by_station[code].append((market_prob, outcome))

                # Climatology: base rate (constant per station/threshold)
                clim_rate = base_rates.get(code, {}).get(key)
                if clim_rate is not None:
                    clim_prob = max(0.0, min(1.0, float(clim_rate)))
                    clim_preds.append((clim_prob, outcome))
                    clim_by_station[code].append((clim_prob, outcome))

    # 6. Compute metrics
    print(f"\n--- Computing calibration metrics ---")

    def build_forecast_report(
        name: str,
        all_preds: list[tuple[float, int]],
        by_station: dict[str, list[tuple[float, int]]],
    ) -> dict:
        brier = compute_brier_score(all_preds)
        reliability = compute_reliability(all_preds)
        print(f"  {name}: {len(all_preds)} predictions, Brier={brier:.4f}" if brier else f"  {name}: no predictions")

        per_station = {}
        for code in STATIONS:
            preds = by_station.get(code, [])
            bs = compute_brier_score(preds)
            per_station[code] = {
                "brier_score": round(bs, 6) if bs is not None else None,
                "n_predictions": len(preds),
            }

        return {
            "brier_score": round(brier, 6) if brier is not None else None,
            "n_predictions": len(all_preds),
            "reliability": reliability,
            "per_station": per_station,
        }

    ensemble_report = build_forecast_report("Ensemble", ensemble_preds, ensemble_by_station)
    market_report = build_forecast_report("Market", market_preds, market_by_station)
    clim_report = build_forecast_report("Climatology", clim_preds, clim_by_station)

    # 7. Build output
    station_details = {}
    for code in STATIONS:
        thresh_results = {}
        for t in THRESHOLDS:
            key = f"{t:.1f}"
            exceeded = None
            if actuals[code] is not None:
                exceeded = actuals[code] > t
            thresh_results[key] = {"exceeded": exceeded}

        station_details[code] = {
            "city": STATIONS[code]["city"],
            "actual_total": round(actuals[code], 2) if actuals[code] is not None else None,
            "thresholds": thresh_results,
        }

    report = {
        "month": month_str,
        "month_name": f"{month_name} {year}",
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "snapshots_analyzed": len(month_snapshots),
        "snapshot_timestamps": {
            "first": month_snapshots[0]["timestamp"] if month_snapshots else None,
            "last": month_snapshots[-1]["timestamp"] if month_snapshots else None,
        },
        "stations": station_details,
        "forecasts": {
            "ensemble": ensemble_report,
            "market": market_report,
            "climatology": clim_report,
        },
    }

    # 8. Print summary
    print(f"\n{'='*60}")
    print(f"CALIBRATION SUMMARY — {month_name} {year}")
    print(f"{'='*60}")
    print(f"Snapshots analyzed:  {len(month_snapshots)}")
    print(f"Stations with data:  {sum(1 for v in actuals.values() if v is not None)}/{len(STATIONS)}")
    print()

    # Actual outcomes table
    print(f"{'Station':<8} {'Total':>6}  ", end="")
    for t in THRESHOLDS:
        print(f">{t:.0f}\"", end="  ")
    print()
    print("-" * 60)
    for code in STATIONS:
        total = actuals[code]
        print(f"{code:<8} {total:>6.2f}  " if total is not None else f"{code:<8}   {'N/A':>4}  ", end="")
        for t in THRESHOLDS:
            key = f"{t:.1f}"
            o = outcomes[code].get(key)
            if o is not None:
                print(f"{'YES' if o else ' no':>3}", end="  ")
            else:
                print(f"{'  -':>3}", end="  ")
        print()

    print()
    print(f"{'Forecast Source':<15} {'Brier':>8} {'N':>6}  {'vs Clim':>8}")
    print("-" * 45)
    clim_bs = clim_report["brier_score"]
    for name, rpt in [("Ensemble", ensemble_report), ("Market", market_report), ("Climatology", clim_report)]:
        bs = rpt["brier_score"]
        n = rpt["n_predictions"]
        if bs is not None:
            delta = ""
            if clim_bs is not None and name != "Climatology":
                improvement = clim_bs - bs
                delta = f"{'+'if improvement>0 else ''}{improvement:.4f}"
            print(f"{name:<15} {bs:>8.4f} {n:>6}  {delta:>8}")
        else:
            print(f"{name:<15} {'N/A':>8} {n:>6}")

    # Brier skill score
    if ensemble_report["brier_score"] is not None and clim_bs is not None and clim_bs > 0:
        bss = 1 - ensemble_report["brier_score"] / clim_bs
        print(f"\nBrier Skill Score (Ensemble vs Clim): {bss:.3f}")
        print(f"  > 0 = better than climatology, 1 = perfect")

    if market_report["brier_score"] is not None and ensemble_report["brier_score"] is not None:
        if market_report["brier_score"] > ensemble_report["brier_score"]:
            print(f"\n  → Ensemble BEATS Market by {market_report['brier_score'] - ensemble_report['brier_score']:.4f}")
        elif market_report["brier_score"] < ensemble_report["brier_score"]:
            print(f"\n  → Market BEATS Ensemble by {ensemble_report['brier_score'] - market_report['brier_score']:.4f}")
        else:
            print(f"\n  → Ensemble and Market tied")

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_month(s: str) -> tuple[int, int]:
    """Parse various month formats into (year, month)."""
    s = s.strip()

    # Try YYYY-MM
    if len(s) >= 6 and "-" in s:
        parts = s.split("-")
        if len(parts) >= 2:
            return int(parts[0]), int(parts[1])

    # Try "April 2026" or "Apr 2026"
    month_names = {
        name.lower(): i for i, name in enumerate(calendar.month_name) if name
    }
    month_abbrs = {
        name.lower(): i for i, name in enumerate(calendar.month_abbr) if name
    }

    words = s.split()
    if len(words) == 2:
        name_word = words[0].lower()
        year_word = words[1]
        m = month_names.get(name_word) or month_abbrs.get(name_word)
        if m:
            return int(year_word), m

    raise ValueError(
        f"Cannot parse month '{s}'. Use YYYY-MM (e.g., 2026-04) or 'April 2026'."
    )


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate forecast calibration for a given month."
    )
    parser.add_argument(
        "month",
        help="Target month: YYYY-MM or 'April 2026'",
    )
    parser.add_argument(
        "--snapshots",
        default=None,
        help="Path to snapshots JSON file (default: /tmp/forecast-snapshots.json)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output path (default: public/data/calibration/{YYYY}-{MM}.json)",
    )
    args = parser.parse_args()

    year, month = parse_month(args.month)

    # Find snapshots file
    snap_path = args.snapshots
    if snap_path is None:
        candidates = [
            "/tmp/forecast-snapshots.json",
            os.path.join(os.path.dirname(__file__), "..", "snapshots.json"),
        ]
        for c in candidates:
            if os.path.exists(c):
                snap_path = c
                break

    if snap_path is None or not os.path.exists(snap_path):
        print(f"Error: No snapshot file found. Provide one with --snapshots.")
        print(f"  Tried: /tmp/forecast-snapshots.json, ./snapshots.json")
        print(f"\nTo export from browser localStorage:")
        print(f'  Open DevTools console, run:')
        print(f'    copy(localStorage.getItem("rainfall-tracker-snapshots"))')
        print(f"  Paste into snapshots.json")
        sys.exit(1)

    # Run evaluation
    report = evaluate_month(year, month, snap_path)

    # Write output
    out_path = args.output
    if out_path is None:
        out_dir = os.path.join(
            os.path.dirname(__file__), "..", "public", "data", "calibration"
        )
        out_dir = os.path.abspath(out_dir)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, f"{year}-{month:02d}.json")

    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nReport written to: {out_path}")


if __name__ == "__main__":
    main()
