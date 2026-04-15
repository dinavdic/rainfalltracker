#!/usr/bin/env python3
"""
Historical rainfall data pipeline using NOAA GHCND daily observations.

Downloads raw `.dly` files from the GHCND archive at
https://www.ncei.noaa.gov/pub/data/ghcn/daily/all/ for 10 US stations,
parses the fixed-width GHCND format (PRCP is tenths of mm → divide by
254 for inches), and fits zero-inflated gamma distributions of
remaining-month rainfall for every (station, month, day-of-month) cell.
Also fits ENSO-conditional gammas per day and computes per-month
threshold base rates, both unconditional and ENSO-conditional.

GHCND gives us the full observational record for each site (many
stations back to the 1940s–1960s), compared with ~1991 onward from the
IEM CLI archive we used previously, so gamma fits on rare-event tails
become much more stable.

Raw `.dly` downloads are cached under scripts/.ghcnd-cache/ so reruns
skip the network.
"""

import json
import math
import os
import sys
import time
from collections import defaultdict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
from scipy import stats

# --- Station config ---------------------------------------------------------
#
# GHCND station IDs. Airport sites use USW00.....; COOP sites use USC00.....
# MDW's airport record doesn't extend as far back as the nearby cooperative
# station (Chicago Midway City, USC00111577), which is what we use.

STATIONS = {
    "SFO": {"city": "San Francisco",     "ghcnd": "USW00023234"},
    "LAX": {"city": "Los Angeles",        "ghcnd": "USW00023174"},
    "MIA": {"city": "Miami",              "ghcnd": "USW00012839"},
    "DEN": {"city": "Denver",             "ghcnd": "USW00023062"},
    "MDW": {"city": "Chicago",            "ghcnd": "USC00111577"},
    "NYC": {"city": "New York",           "ghcnd": "USW00094728"},
    "SEA": {"city": "Seattle",            "ghcnd": "USW00024233"},
    "AUS": {"city": "Austin",             "ghcnd": "USW00013904"},
    "DFW": {"city": "Dallas-Fort Worth",  "ghcnd": "USW00003927"},
    "HOU": {"city": "Houston",            "ghcnd": "USW00012918"},
}

# --- Constants --------------------------------------------------------------

GHCND_BASE = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/all"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".ghcnd-cache")
OUTPUT_PATH = os.path.join(REPO_ROOT, "public", "data", "historical-distributions.json")
ENSO_YEARS_PATH = os.path.join(REPO_ROOT, "public", "data", "enso-years.json")

THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
DAYS_IN_MONTH = {1:31, 2:28, 3:31, 4:30, 5:31, 6:30, 7:31, 8:31, 9:30, 10:31, 11:30, 12:31}
ENSO_PHASES = ["nino", "nina", "neutral"]

USER_AGENT = "RainfallTracker/1.0 (contact@example.com)"


# --- ENSO classification ----------------------------------------------------

def load_enso_years() -> dict[int, str]:
    with open(ENSO_YEARS_PATH) as f:
        raw = json.load(f)
    return {int(k): v for k, v in raw.items()}


# --- GHCND download + parse -------------------------------------------------

def ghcnd_cache_path(station_id: str) -> str:
    return os.path.join(CACHE_DIR, f"{station_id}.dly")


def download_ghcnd(station_id: str) -> str:
    """Download the station's .dly file (cached). Returns local path."""
    dst = ghcnd_cache_path(station_id)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst

    os.makedirs(CACHE_DIR, exist_ok=True)
    url = f"{GHCND_BASE}/{station_id}.dly"

    last_err: Exception | None = None
    for attempt in range(5):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=120) as resp:
                data = resp.read()
            if not data:
                raise RuntimeError("empty response body")
            tmp = dst + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dst)
            return dst
        except (URLError, HTTPError, TimeoutError, RuntimeError) as e:
            last_err = e
            wait = 2 ** (attempt + 1)
            print(f"    Attempt {attempt+1} failed ({e}); retrying in {wait}s…")
            time.sleep(wait)

    raise RuntimeError(f"Failed to download {url}: {last_err}")


def parse_ghcnd_dly(path: str) -> list[dict]:
    """Parse the fixed-width GHCND .dly file and return PRCP records as
    [{year, month, day, prcp (inches)}]. Skips missing (-9999) and any
    values with a non-blank QFLAG (failed a quality check).

    Format reference (per GHCND README):
      ID       chars  0..10   (11)
      YEAR     chars 11..14   (4)
      MONTH    chars 15..16   (2)
      ELEMENT  chars 17..20   (4)
      For day d in 1..31:
        offset = 21 + (d-1)*8
        VALUE  chars offset..offset+4  (5, signed int)
        MFLAG  char  offset+5
        QFLAG  char  offset+6
        SFLAG  char  offset+7
    PRCP values are tenths of mm; inches = value / 254.
    """
    records: list[dict] = []
    with open(path, "r") as f:
        for line in f:
            if len(line) < 21:
                continue
            element = line[17:21]
            if element != "PRCP":
                continue
            try:
                year = int(line[11:15])
                month = int(line[15:17])
            except ValueError:
                continue
            if month < 1 or month > 12:
                continue
            dim = DAYS_IN_MONTH[month]
            for day in range(1, 32):
                if day > dim and not (month == 2 and day == 29):
                    # GHCND still stores Feb 29 entries; allow on leap years
                    # via the -9999 missing flag handling below for non-leap.
                    pass
                off = 21 + (day - 1) * 8
                if off + 8 > len(line):
                    break
                val_str = line[off:off + 5].strip()
                qflag = line[off + 6]
                if qflag != " ":
                    # failed QC
                    continue
                try:
                    val = int(val_str)
                except ValueError:
                    continue
                if val == -9999:
                    continue
                # Guard against Feb 30/31 etc — GHCND pads unused slots
                # with -9999, which we already dropped above.
                if month == 2 and day > 29:
                    continue
                if day > DAYS_IN_MONTH[month] and month != 2:
                    continue
                prcp_in = max(0.0, val / 254.0)
                records.append({"year": year, "month": month, "day": day, "prcp": prcp_in})
    return records


def fetch_ghcnd_station(station_id: str) -> list[dict]:
    path = download_ghcnd(station_id)
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"    downloaded/cached {station_id}.dly ({size_mb:.1f} MB)")
    records = parse_ghcnd_dly(path)
    years = sorted({r["year"] for r in records})
    if years:
        print(
            f"    parsed {len(records):,} daily PRCP obs "
            f"across {len(years)} years ({years[0]}–{years[-1]})"
        )
    else:
        print(f"    parsed 0 PRCP observations — check station id")
    return records


# --- Distribution fitting ---------------------------------------------------

def organize_by_month_year(records: list[dict]) -> dict:
    """Organize records into {(year, month): {day: prcp}}."""
    data: dict = defaultdict(dict)
    for r in records:
        data[(r["year"], r["month"])][r["day"]] = r["prcp"]
    return data


def fit_gamma(values_arr: np.ndarray) -> dict | None:
    positive_vals = values_arr[values_arr > 0]
    zero_fraction = float(np.mean(values_arr == 0))

    if len(positive_vals) >= 5:
        try:
            shape, _loc, scale = stats.gamma.fit(positive_vals, floc=0)
            if math.isfinite(shape) and math.isfinite(scale) and shape > 0 and scale > 0:
                return {
                    "shape": round(float(shape), 4),
                    "scale": round(float(scale), 4),
                    "zero_fraction": round(zero_fraction, 4),
                }
        except Exception:
            pass
    return None


def compute_base_rates(totals_arr: np.ndarray) -> dict:
    return {str(t): round(float(np.mean(totals_arr > t)), 4) for t in THRESHOLDS}


def compute_distributions(monthly_data: dict, enso_years: dict[int, str]) -> dict:
    """For each month × current-day, fit remaining-period rainfall
    distributions (unconditional + ENSO-conditional).
    """
    result: dict = {}

    for month in range(1, 13):
        dim = DAYS_IN_MONTH[month]
        if month == 2:
            dim = 29  # include leap-day data where available

        year_months = sorted((y, m) for (y, m) in monthly_data.keys() if m == month)
        if not year_months:
            continue

        enso_ym: dict[str, list] = {phase: [] for phase in ENSO_PHASES}
        for (y, m) in year_months:
            phase = enso_years.get(y, "neutral")
            enso_ym[phase].append((y, m))

        monthly_totals = [
            sum(monthly_data[(y, m)].get(d, 0.0) for d in range(1, dim + 1))
            for (y, m) in year_months
        ]
        monthly_totals_arr = np.array(monthly_totals)
        base_rates = compute_base_rates(monthly_totals_arr)

        enso_base_rates: dict = {}
        for phase in ENSO_PHASES:
            phase_totals = [
                sum(monthly_data[(y, m)].get(d, 0.0) for d in range(1, dim + 1))
                for (y, m) in enso_ym[phase]
            ]
            enso_base_rates[phase] = (
                compute_base_rates(np.array(phase_totals)) if phase_totals else {}
            )

        month_percentiles: dict = {}
        if len(monthly_totals_arr) > 0:
            for p in [5, 10, 25, 50, 75, 90, 95]:
                month_percentiles[str(p)] = round(
                    float(np.percentile(monthly_totals_arr, p)), 3
                )

        days_result: dict = {}
        for current_day in range(0, dim):
            remaining_values = [
                sum(monthly_data[(y, m)].get(d, 0.0) for d in range(current_day + 1, dim + 1))
                for (y, m) in year_months
            ]
            remaining_arr = np.array(remaining_values)

            percentiles: dict = {}
            if len(remaining_arr) > 0:
                for p in [5, 10, 25, 50, 75, 90, 95]:
                    percentiles[str(p)] = round(
                        float(np.percentile(remaining_arr, p)), 3
                    )

            gamma_params = fit_gamma(remaining_arr)

            enso_gamma: dict = {}
            for phase in ENSO_PHASES:
                phase_remaining = [
                    sum(monthly_data[(y, m)].get(d, 0.0)
                        for d in range(current_day + 1, dim + 1))
                    for (y, m) in enso_ym[phase]
                ]
                enso_gamma[phase] = (
                    fit_gamma(np.array(phase_remaining)) if phase_remaining else None
                )

            days_result[str(current_day)] = {
                "percentiles": percentiles,
                "gamma": gamma_params,
                "gamma_nino": enso_gamma.get("nino"),
                "gamma_nina": enso_gamma.get("nina"),
                "gamma_neutral": enso_gamma.get("neutral"),
                "n_years": len(remaining_values),
                "mean": round(float(np.mean(remaining_arr)), 3),
            }

        cumulative_percentiles: dict = {}
        for day_num in range(1, DAYS_IN_MONTH[month] + 1):
            cum_values = [
                sum(monthly_data[(y, m)].get(d, 0.0) for d in range(1, day_num + 1))
                for (y, m) in year_months
            ]
            cum_arr = np.array(cum_values)
            if len(cum_arr) > 0:
                cumulative_percentiles[str(day_num)] = {
                    "p10": round(float(np.percentile(cum_arr, 10)), 3),
                    "p25": round(float(np.percentile(cum_arr, 25)), 3),
                    "p50": round(float(np.percentile(cum_arr, 50)), 3),
                    "p75": round(float(np.percentile(cum_arr, 75)), 3),
                    "p90": round(float(np.percentile(cum_arr, 90)), 3),
                }

        result[str(month)] = {
            "days_in_month": DAYS_IN_MONTH[month],
            "days": days_result,
            "base_rates": base_rates,
            "base_rates_nino": enso_base_rates.get("nino", {}),
            "base_rates_nina": enso_base_rates.get("nina", {}),
            "base_rates_neutral": enso_base_rates.get("neutral", {}),
            "monthly_totals_percentiles": month_percentiles,
            "cumulative_percentiles": cumulative_percentiles,
        }

    return result


# --- Year-count summary -----------------------------------------------------

def load_old_year_counts() -> dict[str, int]:
    """Read the existing historical-distributions.json (if present) and
    return a per-station year-count map, using April's day-0 n_years as
    the representative value (same window every station has).
    """
    if not os.path.exists(OUTPUT_PATH):
        return {}
    try:
        with open(OUTPUT_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    out: dict[str, int] = {}
    for code, sdata in (data.get("stations") or {}).items():
        april = (sdata.get("months") or {}).get("4") or {}
        day0 = (april.get("days") or {}).get("0") or {}
        if "n_years" in day0:
            out[code] = int(day0["n_years"])
    return out


# --- Main -------------------------------------------------------------------

def main() -> int:
    enso_years = load_enso_years()
    print(f"Loaded ENSO classifications for {len(enso_years)} years")
    for phase in ENSO_PHASES:
        ys = sorted(y for y, p in enso_years.items() if p == phase)
        print(f"  {phase}: {len(ys)} years")

    old_counts = load_old_year_counts()

    output = {
        "stations": {},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "NOAA GHCND (www.ncei.noaa.gov/pub/data/ghcn/daily/all)",
        "enso_conditioned": True,
    }

    year_stats: dict[str, dict] = {}

    for station_code, info in STATIONS.items():
        print(f"\nProcessing {station_code} ({info['city']}, GHCND: {info['ghcnd']})…")
        try:
            records = fetch_ghcnd_station(info["ghcnd"])
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            continue

        if not records:
            print(f"  Skipping {station_code} — no usable records")
            continue

        monthly_data = organize_by_month_year(records)
        print(f"  Organized into {len(monthly_data)} station-months")

        distributions = compute_distributions(monthly_data, enso_years)
        print(f"  Computed distributions for {len(distributions)} months")

        all_years = sorted({r["year"] for r in records})
        year_stats[station_code] = {
            "new_years": len(all_years),
            "year_start": all_years[0] if all_years else None,
            "year_end": all_years[-1] if all_years else None,
        }

        output["stations"][station_code] = {
            "city": info["city"],
            "ghcnd_id": info["ghcnd"],
            "months": distributions,
        }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f)

    size_mb = os.path.getsize(OUTPUT_PATH) / (1024 * 1024)
    print(f"\nOutput written to {OUTPUT_PATH} ({size_mb:.1f} MB)")

    # --- Summary: old (IEM) vs new (GHCND) year counts ---
    print("\n" + "=" * 70)
    print("Year-count summary (old = previous file / new = GHCND .dly)")
    print("=" * 70)
    print(f"{'Station':<10}{'Old yrs':>10}{'New yrs':>10}{'Delta':>8}  {'New range':>12}")
    print("-" * 70)
    for code in STATIONS:
        old_n = old_counts.get(code, 0)
        stats_row = year_stats.get(code)
        if not stats_row:
            print(f"{code:<10}{old_n:>10}{'—':>10}{'—':>8}  {'—':>12}")
            continue
        new_n = stats_row["new_years"]
        delta = new_n - old_n
        rng = f"{stats_row['year_start']}–{stats_row['year_end']}"
        delta_str = f"{delta:+d}" if old_n else "(new)"
        print(f"{code:<10}{old_n:>10}{new_n:>10}{delta_str:>8}  {rng:>12}")
    print("=" * 70)

    print("\nDone!")
    return 0


if __name__ == "__main__":
    sys.exit(main())
