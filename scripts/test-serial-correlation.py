#!/usr/bin/env python3
"""
Test whether preceding-month(s) precipitation predicts April precipitation
at each of the 10 tracked stations.

For each year 1991-2025, we compute January-April monthly totals from IEM
CLI daily data, then test:
  1. Pearson r between Jan-Mar total and April total
  2. Pearson r between March total and April total
  3. Conditional mean April rainfall when Jan-Mar was in the top tercile
     (wet winter) vs bottom tercile (dry winter)
  4. Welch's t-test on the (wet-winter April) vs (dry-winter April) means

Output: a table per station showing correlations, conditional means, p-value,
and a significance flag. This tells us whether antecedent precipitation
conditioning would actually improve the model, and for which stations.

Usage:
    python3 scripts/test-serial-correlation.py               # full analysis
    python3 scripts/test-serial-correlation.py --diagnose    # inspect gaps

Caches raw fetched data to scripts/.serial-correlation-cache.json so reruns
are fast.
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

import numpy as np
from scipy import stats

# 10 tracked stations — same list as build-historical-data.py
STATIONS = {
    "SFO": {"city": "San Francisco",     "icao": "KSFO"},
    "LAX": {"city": "Los Angeles",        "icao": "KLAX"},
    "MIA": {"city": "Miami",              "icao": "KMIA"},
    "DEN": {"city": "Denver",             "icao": "KDEN"},
    "MDW": {"city": "Chicago",            "icao": "KMDW"},
    "NYC": {"city": "New York",           "icao": "KNYC"},
    "SEA": {"city": "Seattle",            "icao": "KSEA"},
    "AUS": {"city": "Austin",             "icao": "KAUS"},
    "DFW": {"city": "Dallas-Fort Worth",  "icao": "KDFW"},
    "HOU": {"city": "Houston",            "icao": "KHOU"},
}

IEM_BASE = "https://mesonet.agron.iastate.edu/json/cli.py"
START_YEAR = 1991
END_YEAR = 2025
SIGNIFICANCE_ALPHA = 0.05

CACHE_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    ".serial-correlation-cache.json",
)


# ---------- Data fetching ----------

def fetch_iem_year_raw(icao: str, year: int) -> list[dict]:
    """Fetch one year of CLI data, returning raw IEM result entries (unfiltered)."""
    url = f"{IEM_BASE}?station={icao}&year={year}"
    for attempt in range(5):
        try:
            req = Request(url, headers={
                "User-Agent": "RainfallTracker/1.0 (serial-correlation-test)"
            })
            with urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            break
        except (URLError, HTTPError, TimeoutError) as e:
            wait = 2 ** (attempt + 1)
            print(f"    attempt {attempt+1} failed ({e}), retry in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
        except json.JSONDecodeError as e:
            print(f"    JSON decode error for {icao} {year}: {e}", file=sys.stderr)
            return []
    else:
        print(f"    FAILED {icao} {year} after 5 attempts", file=sys.stderr)
        return []

    return data.get("results", [])


def parse_raw_entries(raw: list[dict]) -> list[dict]:
    """
    Convert raw IEM entries into daily records with numeric precip.
    'M' (missing) is dropped. 'T' (trace, < 0.005") is treated as 0.0
    since it is a valid observation of near-zero precipitation, not
    missing data.
    """
    records = []
    for entry in raw:
        date_str = entry.get("valid", "")
        precip_val = entry.get("precip")
        if not date_str or precip_val is None or precip_val == "M":
            continue
        # Trace: valid observation of near-zero precipitation
        if precip_val == "T":
            prcp = 0.0
        else:
            try:
                prcp = max(0.0, float(precip_val))
            except (ValueError, TypeError):
                continue
        try:
            y, m, d = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
        except (ValueError, IndexError):
            continue
        records.append({"year": y, "month": m, "day": d, "prcp": prcp})
    return records


def load_cache() -> dict:
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_cache(cache: dict) -> None:
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f)


def fetch_station_raw(code: str, icao: str, cache: dict) -> list[dict]:
    """Fetch all years of raw IEM entries for a station, using cache when possible."""
    cache_key = f"{code}_raw_{START_YEAR}_{END_YEAR}"
    if cache_key in cache:
        print(f"  (using cache: {len(cache[cache_key])} entries)", flush=True)
        return cache[cache_key]

    all_raw = []
    for year in range(START_YEAR, END_YEAR + 1):
        print(f"  fetching {icao} {year}...", flush=True)
        raw = fetch_iem_year_raw(icao, year)
        all_raw.extend(raw)
        time.sleep(0.2)  # be polite to IEM

    cache[cache_key] = all_raw
    save_cache(cache)
    return all_raw


# ---------- Monthly aggregation ----------

def compute_monthly_totals(records: list[dict]) -> dict[int, dict[int, float]]:
    """
    Return {year: {month: total_precip}} for months 1-4 only.
    Requires at least 25 days of data in the month to count as valid.
    """
    day_counts: dict[tuple[int, int], int] = defaultdict(int)
    totals: dict[tuple[int, int], float] = defaultdict(float)
    for r in records:
        m = r["month"]
        if m < 1 or m > 4:
            continue
        key = (r["year"], m)
        day_counts[key] += 1
        totals[key] += r["prcp"]

    result: dict[int, dict[int, float]] = defaultdict(dict)
    for (year, month), total in totals.items():
        min_days = {1: 25, 2: 24, 3: 25, 4: 25}[month]
        if day_counts[(year, month)] >= min_days:
            result[year][month] = total
    return result


def build_year_series(
    monthly: dict[int, dict[int, float]],
) -> tuple[list[int], list[float], list[float], list[float]]:
    """
    Build aligned arrays: years, Jan-Mar totals, March totals, April totals.
    Only includes years where all four monthly totals (Jan, Feb, Mar, Apr) exist.
    """
    years, janmar, march, april = [], [], [], []
    for year in sorted(monthly):
        m = monthly[year]
        if all(k in m for k in (1, 2, 3, 4)):
            years.append(year)
            janmar.append(m[1] + m[2] + m[3])
            march.append(m[3])
            april.append(m[4])
    return years, janmar, march, april


# ---------- Diagnostics ----------

MIN_DAYS = {1: 25, 2: 24, 3: 25, 4: 25}


def categorize_entries(raw: list[dict]) -> dict[tuple[int, int], dict[str, int]]:
    """
    Bucket raw IEM entries by (year, month) and count category totals.
    Categories:
      - valid: numeric precip (gets included in the monthly total)
      - trace: precip == 'T' (dropped by current filter)
      - missing: precip is None or 'M'
      - parse_error: non-numeric, non-'T', non-'M'
      - total: all entries for that month
    """
    buckets: dict[tuple[int, int], dict[str, int]] = defaultdict(
        lambda: {"valid": 0, "trace": 0, "missing": 0, "parse_error": 0, "total": 0}
    )
    for entry in raw:
        date_str = entry.get("valid", "")
        if not date_str or len(date_str) < 7:
            continue
        try:
            y = int(date_str[:4])
            m = int(date_str[5:7])
        except (ValueError, IndexError):
            continue
        if m < 1 or m > 4:
            continue

        key = (y, m)
        buckets[key]["total"] += 1

        precip_val = entry.get("precip")
        if precip_val is None or precip_val == "M":
            buckets[key]["missing"] += 1
        elif precip_val == "T":
            buckets[key]["trace"] += 1
        else:
            try:
                float(precip_val)
                buckets[key]["valid"] += 1
            except (ValueError, TypeError):
                buckets[key]["parse_error"] += 1
    return dict(buckets)


MONTH_NAME = {1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr"}


def diagnose_station(code: str, info: dict, raw: list[dict]) -> None:
    """Print a detailed diagnostic for one station."""
    print()
    print("=" * 78)
    print(f"[{code}] {info['city']} ({info['icao']})")
    print("=" * 78)

    # Inventory of years returned by IEM
    years_with_entries: set[int] = set()
    total_entries = 0
    for entry in raw:
        total_entries += 1
        ds = entry.get("valid", "")
        if ds and len(ds) >= 4:
            try:
                years_with_entries.add(int(ds[:4]))
            except ValueError:
                pass

    expected_years = set(range(START_YEAR, END_YEAR + 1))
    missing_years = sorted(expected_years - years_with_entries)
    present_years = sorted(years_with_entries & expected_years)

    print(f"  Total raw entries from IEM: {total_entries}")
    print(
        f"  Years with any entries: {len(present_years)} / "
        f"{len(expected_years)} expected ({START_YEAR}-{END_YEAR})"
    )
    if missing_years:
        print(f"  Years with NO entries returned: {missing_years}")
    else:
        print(f"  Every year in {START_YEAR}-{END_YEAR} returned at least some data")

    # Per-(year, month) category counts
    buckets = categorize_entries(raw)

    # Parser now counts trace ('T') as 0.0 (a valid observation), so
    # the pass/fail threshold check must include trace days too.
    complete_years: list[int] = []
    incomplete_years: list[tuple[int, list[tuple[int, dict[str, int]]]]] = []
    for year in sorted(expected_years):
        months_fail: list[tuple[int, dict[str, int]]] = []
        for m in (1, 2, 3, 4):
            b = buckets.get((year, m), {
                "valid": 0, "trace": 0, "missing": 0,
                "parse_error": 0, "total": 0,
            })
            if b["valid"] + b["trace"] < MIN_DAYS[m]:
                months_fail.append((m, b))
        if not months_fail:
            complete_years.append(year)
        else:
            incomplete_years.append((year, months_fail))

    print(
        f"  Years with all Jan-Apr meeting the {MIN_DAYS} valid-day thresholds: "
        f"{len(complete_years)}"
    )
    print(f"  Years dropped due to incomplete months: {len(incomplete_years)}")

    if incomplete_years:
        print()
        print(
            f"  Dropped-year detail  "
            f"(valid = numeric precip; trace = 'T' counted as 0.0; "
            f"miss = 'M'/null; perr = unparseable)"
        )
        print(
            f"    {'year':>4} {'mo':>3} {'need':>4} "
            f"{'valid':>5} {'trace':>5} {'miss':>4} {'perr':>4} {'total':>5}  "
            f"reason"
        )
        for year, months_fail in incomplete_years:
            for m, b in months_fail:
                need = MIN_DAYS[m]
                usable = b["valid"] + b["trace"]
                if b["total"] == 0:
                    reason = "no entries at all for this month"
                elif b["missing"] > 0 and usable < need:
                    reason = f"{b['missing']} days reported as 'M'/missing"
                else:
                    reason = f"short month in IEM response ({b['total']} entries)"
                print(
                    f"    {year:>4} {MONTH_NAME[m]:>3} {need:>4} "
                    f"{b['valid']:>5} {b['trace']:>5} {b['missing']:>4} "
                    f"{b['parse_error']:>4} {b['total']:>5}  {reason}"
                )

    # Aggregate summary
    no_data_months = 0
    for _year, months_fail in incomplete_years:
        for _m, b in months_fail:
            if b["total"] == 0:
                no_data_months += 1

    total_failed_months = sum(len(mf) for _, mf in incomplete_years)
    print()
    print(f"  Failed-month breakdown (out of {total_failed_months} total):")
    print(f"    - Had zero entries returned from IEM:            {no_data_months}")
    print(
        f"    - Other (genuine missing/null days):             "
        f"{total_failed_months - no_data_months}"
    )


def run_diagnostics(codes: list[str]) -> None:
    """Fetch and diagnose the specified station codes."""
    print("Starting diagnostics...", flush=True)
    cache = load_cache()
    print(f"Diagnostic mode — stations: {', '.join(codes)}", flush=True)
    print(f"Years: {START_YEAR}-{END_YEAR}", flush=True)
    print(f"Cache: {CACHE_PATH}", flush=True)
    for code in codes:
        info = STATIONS.get(code)
        if info is None:
            print(f"Unknown station code: {code}", file=sys.stderr, flush=True)
            continue
        print(f"\n[{code}] fetching / loading cache...", flush=True)
        raw = fetch_station_raw(code, info["icao"], cache)
        diagnose_station(code, info, raw)
        sys.stdout.flush()


# ---------- Statistics ----------

def analyze_station(
    code: str, janmar: list[float], march: list[float], april: list[float],
) -> dict:
    """Run all correlation + tercile tests for one station."""
    n = len(april)
    if n < 10:
        return {"code": code, "n": n, "insufficient": True}

    jm = np.array(janmar)
    mar = np.array(march)
    apr = np.array(april)

    r_jm, p_jm = stats.pearsonr(jm, apr)
    r_mar, p_mar = stats.pearsonr(mar, apr)

    # Terciles of Jan-Mar
    lo, hi = np.percentile(jm, [100 / 3, 200 / 3])
    dry_mask = jm <= lo
    wet_mask = jm >= hi
    dry_april = apr[dry_mask]
    wet_april = apr[wet_mask]

    mean_dry = float(np.mean(dry_april))
    mean_wet = float(np.mean(wet_april))
    mean_all = float(np.mean(apr))

    # Welch's t-test (unequal variances)
    if len(dry_april) >= 2 and len(wet_april) >= 2:
        t_stat, p_ttest = stats.ttest_ind(wet_april, dry_april, equal_var=False)
    else:
        t_stat, p_ttest = float("nan"), float("nan")

    significant = (not np.isnan(p_ttest)) and p_ttest < SIGNIFICANCE_ALPHA
    direction = None
    if significant:
        direction = "positive" if mean_wet > mean_dry else "negative"

    return {
        "code": code,
        "n": n,
        "insufficient": False,
        "r_janmar": float(r_jm),
        "p_janmar": float(p_jm),
        "r_march": float(r_mar),
        "p_march": float(p_mar),
        "mean_april_dry": mean_dry,
        "mean_april_wet": mean_wet,
        "mean_april_all": mean_all,
        "n_dry": int(dry_mask.sum()),
        "n_wet": int(wet_mask.sum()),
        "t_stat": float(t_stat),
        "p_ttest": float(p_ttest),
        "significant": bool(significant),
        "direction": direction,
    }


# ---------- Output ----------

def fmt_p(p: float) -> str:
    if np.isnan(p):
        return "   n/a"
    if p < 0.001:
        return " <0.001"
    return f"{p:6.3f}"


def fmt_r(r: float) -> str:
    return f"{r:+.3f}"


def print_table(results: list[dict]) -> None:
    header = (
        f"{'Stn':<4} {'N':>3} | "
        f"{'r(JM,A)':>8} {'p':>7} | "
        f"{'r(M,A)':>8} {'p':>7} | "
        f"{'dry Apr':>8} {'wet Apr':>8} {'all Apr':>8} | "
        f"{'t':>6} {'p':>7} {'sig?':>5} {'sign':>9}"
    )
    print(header)
    print("-" * len(header))

    for r in results:
        if r.get("insufficient"):
            print(f"{r['code']:<4} {r['n']:>3} | (insufficient data)")
            continue
        sig_mark = "YES" if r["significant"] else "no"
        direction = r["direction"] if r["direction"] else "-"
        print(
            f"{r['code']:<4} {r['n']:>3} | "
            f"{fmt_r(r['r_janmar']):>8} {fmt_p(r['p_janmar']):>7} | "
            f"{fmt_r(r['r_march']):>8} {fmt_p(r['p_march']):>7} | "
            f"{r['mean_april_dry']:>8.2f} {r['mean_april_wet']:>8.2f} "
            f"{r['mean_april_all']:>8.2f} | "
            f"{r['t_stat']:>6.2f} {fmt_p(r['p_ttest']):>7} "
            f"{sig_mark:>5} {direction:>9}"
        )


def print_summary(results: list[dict]) -> None:
    print()
    print("Summary:")
    print(f"  Significance level: alpha = {SIGNIFICANCE_ALPHA}")
    print(f"  Comparison: mean April rainfall in wet-winter (top tercile Jan-Mar)")
    print(f"              vs dry-winter (bottom tercile Jan-Mar) years, Welch's t-test")
    print()
    sig_results = [r for r in results if not r.get("insufficient") and r["significant"]]
    if not sig_results:
        print("  No stations show statistically significant serial correlation")
        print("  between Jan-Mar winter precipitation and April precipitation.")
        print("  => Antecedent precipitation conditioning is unlikely to improve")
        print("     April forecasts at these stations.")
    else:
        print(f"  {len(sig_results)} station(s) with significant effect:")
        for r in sig_results:
            delta = r["mean_april_wet"] - r["mean_april_dry"]
            note = (
                "wet winter => wet April (positive serial corr)"
                if r["direction"] == "positive"
                else "wet winter => dry April (regression to mean / negative)"
            )
            print(
                f"    {r['code']}: {note} "
                f"(delta={delta:+.2f}\", p={r['p_ttest']:.3f})"
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Test whether Jan-Mar precipitation predicts April "
            "precipitation at each tracked station."
        )
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help=(
            "Run diagnostic mode for DEN, MDW, AUS, HOU only, reporting "
            "per-year data completeness from IEM."
        ),
    )
    args = parser.parse_args()

    if args.diagnose:
        run_diagnostics(["DEN", "MDW", "AUS", "HOU"])
        return

    print(f"Serial correlation test: does Jan-Mar predict April rainfall?")
    print(f"Stations: {', '.join(STATIONS.keys())}")
    print(f"Years: {START_YEAR}-{END_YEAR}")
    print(f"Cache: {CACHE_PATH}")
    print()

    cache = load_cache()
    results = []

    for code, info in STATIONS.items():
        print(f"[{code}] {info['city']} (fetching / loading cache)...")
        raw = fetch_station_raw(code, info["icao"], cache)
        records = parse_raw_entries(raw)
        monthly = compute_monthly_totals(records)
        _, janmar, march, april = build_year_series(monthly)
        result = analyze_station(code, janmar, march, april)
        results.append(result)

    print()
    print_table(results)
    print_summary(results)


if __name__ == "__main__":
    main()
