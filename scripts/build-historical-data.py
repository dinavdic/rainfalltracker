#!/usr/bin/env python3
"""
Historical rainfall data pipeline using IEM CLI archive.

Downloads daily precipitation data from the Iowa Environmental Mesonet (IEM)
CLI archive for 10 US stations (1991-2024). This data matches the exact
NWS CLI reports used for Kalshi settlement.

IEM CLI archive: https://mesonet.agron.iastate.edu/cgi-bin/request/cli.py

Computes empirical distributions of remaining-period rainfall for each
station-month-day combination, fits gamma distributions, and outputs a JSON
file for the frontend.
"""

import json
import csv
import io
import sys
import os
import time
import math
from collections import defaultdict
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import numpy as np
from scipy import stats

# Station codes match IEM CLI identifiers and Kalshi settlement stations.
STATIONS = {
    "SFO": {"city": "San Francisco",  "iem_code": "SFO"},
    "LAX": {"city": "Los Angeles",    "iem_code": "LAX"},
    "MIA": {"city": "Miami",          "iem_code": "MIA"},
    "DEN": {"city": "Denver",         "iem_code": "DEN"},
    "MDW": {"city": "Chicago",        "iem_code": "MDW"},
    "NYC": {"city": "New York",       "iem_code": "NYC"},
    "SEA": {"city": "Seattle",        "iem_code": "SEA"},
    "AUS": {"city": "Austin",         "iem_code": "AUS"},
    "DFW": {"city": "Dallas-Fort Worth", "iem_code": "DFW"},
    "HOU": {"city": "Houston",        "iem_code": "HOU"},
}

IEM_BASE = "https://mesonet.agron.iastate.edu/cgi-bin/request/cli.py"
THRESHOLDS = [1.0, 2.0, 3.0]

DAYS_IN_MONTH = {1:31, 2:28, 3:31, 4:30, 5:31, 6:30, 7:31, 8:31, 9:30, 10:31, 11:30, 12:31}


def fetch_iem_cli_data(iem_code: str) -> list[dict]:
    """Download daily precipitation data from IEM CLI archive."""
    url = (
        f"{IEM_BASE}?station={iem_code}"
        f"&year1=1991&month1=1&day1=1"
        f"&year2=2024&month2=12&day2=31"
        f"&output=csv"
    )
    print(f"  Fetching {url}")

    for attempt in range(5):
        try:
            req = Request(url, headers={
                "User-Agent": "RainfallTracker/1.0 (contact@example.com)"
            })
            with urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8")
            break
        except (URLError, HTTPError, TimeoutError) as e:
            wait = 2 ** (attempt + 1)
            print(f"  Attempt {attempt+1} failed ({e}), retrying in {wait}s...")
            time.sleep(wait)
    else:
        print(f"  FAILED to fetch data for {iem_code} after 5 attempts")
        return []

    reader = csv.DictReader(io.StringIO(raw))
    records = []
    for row in reader:
        try:
            date_str = row.get("valid", "").strip()
            prcp_str = row.get("precip", "").strip()

            if not date_str or not prcp_str:
                continue

            # IEM uses "M" for missing and "T" for trace
            if prcp_str in ("M", "None", ""):
                continue
            if prcp_str == "T":
                prcp = 0.0  # Trace = effectively 0 for accumulation
            else:
                prcp = float(prcp_str)

            if prcp < 0:
                prcp = 0.0

            year, month, day = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
            records.append({"year": year, "month": month, "day": day, "prcp": prcp})
        except (ValueError, KeyError, IndexError):
            continue

    print(f"  Got {len(records)} daily records")
    return records


def organize_by_month_year(records: list[dict]) -> dict:
    """Organize records into {(year, month): {day: prcp}}."""
    data = defaultdict(dict)
    for r in records:
        data[(r["year"], r["month"])][r["day"]] = r["prcp"]
    return data


def compute_distributions(monthly_data: dict) -> dict:
    """
    For each calendar month (1-12) and each day-of-month (0 through dim-1),
    compute the empirical distribution of remaining-period rainfall
    (from day+1 through end of month).

    Returns a dict keyed by month (1-12) with:
      - days: dict keyed by day (0 through dim-1) with percentiles and gamma params
      - base_rates: {threshold: fraction}
      - monthly_totals_percentiles: percentiles of full-month totals
      - cumulative_percentiles: for chart display
    """
    result = {}

    for month in range(1, 13):
        dim = DAYS_IN_MONTH[month]
        # For February, also include leap year data (day 29)
        if month == 2:
            dim = 29

        # Collect all year-months for this calendar month
        year_months = sorted([(y, m) for (y, m) in monthly_data.keys() if m == month])

        if not year_months:
            continue

        # Compute full-month totals for base rates
        monthly_totals = []
        for (y, m) in year_months:
            days_data = monthly_data[(y, m)]
            total = sum(days_data.get(d, 0.0) for d in range(1, dim + 1))
            monthly_totals.append(total)

        monthly_totals_arr = np.array(monthly_totals)

        base_rates = {}
        for thresh in THRESHOLDS:
            frac = float(np.mean(monthly_totals_arr > thresh))
            base_rates[str(thresh)] = round(frac, 4)

        month_percentiles = {}
        if len(monthly_totals_arr) > 0:
            for p in [5, 10, 25, 50, 75, 90, 95]:
                month_percentiles[str(p)] = round(float(np.percentile(monthly_totals_arr, p)), 3)

        # For each possible "current day" (0 = start of month, 1 = after day 1, etc.)
        days_result = {}
        for current_day in range(0, dim):
            remaining_values = []
            for (y, m) in year_months:
                days_data = monthly_data[(y, m)]
                remaining = sum(days_data.get(d, 0.0) for d in range(current_day + 1, dim + 1))
                remaining_values.append(remaining)

            remaining_arr = np.array(remaining_values)

            percentiles = {}
            if len(remaining_arr) > 0:
                for p in [5, 10, 25, 50, 75, 90, 95]:
                    percentiles[str(p)] = round(float(np.percentile(remaining_arr, p)), 3)

            # Fit gamma distribution (zero-inflated)
            gamma_params = None
            positive_vals = remaining_arr[remaining_arr > 0]
            zero_fraction = float(np.mean(remaining_arr == 0))

            if len(positive_vals) >= 5:
                try:
                    shape, loc, scale = stats.gamma.fit(positive_vals, floc=0)
                    if math.isfinite(shape) and math.isfinite(scale) and shape > 0 and scale > 0:
                        gamma_params = {
                            "shape": round(float(shape), 4),
                            "scale": round(float(scale), 4),
                            "zero_fraction": round(zero_fraction, 4),
                        }
                except Exception:
                    pass

            days_result[str(current_day)] = {
                "percentiles": percentiles,
                "gamma": gamma_params,
                "n_years": len(remaining_values),
                "mean": round(float(np.mean(remaining_arr)), 3),
            }

        # Cumulative percentiles for the chart (day 1..dim)
        cumulative_percentiles = {}
        for day_num in range(1, DAYS_IN_MONTH[month] + 1):
            cum_values = []
            for (y, m) in year_months:
                days_data = monthly_data[(y, m)]
                cum = sum(days_data.get(d, 0.0) for d in range(1, day_num + 1))
                cum_values.append(cum)
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
            "monthly_totals_percentiles": month_percentiles,
            "cumulative_percentiles": cumulative_percentiles,
        }

    return result


def main():
    output = {
        "stations": {},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "IEM CLI Archive (mesonet.agron.iastate.edu)",
    }

    for station_code, info in STATIONS.items():
        print(f"\nProcessing {station_code} ({info['city']}, IEM code: {info['iem_code']})...")

        records = fetch_iem_cli_data(info["iem_code"])
        if not records:
            print(f"  Skipping {station_code} - no data")
            continue

        monthly_data = organize_by_month_year(records)
        print(f"  Organized into {len(monthly_data)} station-months")

        distributions = compute_distributions(monthly_data)
        print(f"  Computed distributions for {len(distributions)} months")

        output["stations"][station_code] = {
            "city": info["city"],
            "iem_code": info["iem_code"],
            "months": distributions,
        }

    output_path = "public/data/historical-distributions.json"
    with open(output_path, "w") as f:
        json.dump(output, f)

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nOutput written to {output_path} ({size_mb:.1f} MB)")
    print("Done!")


if __name__ == "__main__":
    main()
