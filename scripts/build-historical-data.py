#!/usr/bin/env python3
"""
Historical rainfall data pipeline.

Downloads daily precipitation data from NOAA GHCN-Daily for 6 US airport stations,
computes empirical distributions of remaining-period rainfall for each station-month-day
combination, fits gamma distributions, and outputs a JSON file for the frontend.
"""

import json
import csv
import io
import sys
import time
import math
from collections import defaultdict
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import numpy as np
from scipy import stats

STATIONS = {
    "SFO": {"city": "San Francisco", "ghcn_id": "USW00023234"},
    "MIA": {"city": "Miami",         "ghcn_id": "USW00012839"},
    "DEN": {"city": "Denver",        "ghcn_id": "USW00023062"},
    "ORD": {"city": "Chicago",       "ghcn_id": "USW00094846"},
    "JFK": {"city": "New York",      "ghcn_id": "USW00094789"},
    "SEA": {"city": "Seattle",       "ghcn_id": "USW00024233"},
}

NOAA_BASE = "https://www.ncei.noaa.gov/access/services/data/v1"
START_DATE = "1991-01-01"
END_DATE = "2024-12-31"
THRESHOLDS = [1.0, 2.0, 3.0]

# Days in each month (non-leap year). February uses 28; leap day data gets included in Feb calculations.
DAYS_IN_MONTH = {1:31, 2:28, 3:31, 4:30, 5:31, 6:30, 7:31, 8:31, 9:30, 10:31, 11:30, 12:31}


def fetch_ghcn_data(ghcn_id: str) -> list[dict]:
    """Download daily precipitation data from NOAA GHCN-Daily."""
    url = (
        f"{NOAA_BASE}?dataset=daily-summaries&dataTypes=PRCP"
        f"&stations={ghcn_id}&startDate={START_DATE}&endDate={END_DATE}"
        f"&units=standard&format=csv"
    )
    print(f"  Fetching {url[:80]}...")

    for attempt in range(5):
        try:
            req = Request(url, headers={
                "User-Agent": "RainfallTracker/1.0 (contact@example.com)"
            })
            with urlopen(req, timeout=120) as resp:
                raw = resp.read().decode("utf-8")
            break
        except (URLError, HTTPError, TimeoutError) as e:
            wait = 2 ** (attempt + 1)
            print(f"  Attempt {attempt+1} failed ({e}), retrying in {wait}s...")
            time.sleep(wait)
    else:
        print(f"  FAILED to fetch data for {ghcn_id} after 5 attempts")
        return []

    reader = csv.DictReader(io.StringIO(raw))
    records = []
    for row in reader:
        try:
            date_str = row.get("DATE", "")
            prcp_str = row.get("PRCP", "")
            if not date_str or prcp_str == "":
                continue
            prcp = float(prcp_str)
            # PRCP can be negative (trace amounts coded as special values); treat as 0
            if prcp < 0:
                prcp = 0.0
            year, month, day = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
            records.append({"year": year, "month": month, "day": day, "prcp": prcp})
        except (ValueError, KeyError):
            continue

    print(f"  Got {len(records)} daily records")
    return records


def organize_by_month_year(records: list[dict]) -> dict:
    """
    Organize records into {(year, month): {day: prcp}}.
    """
    data = defaultdict(dict)
    for r in records:
        data[(r["year"], r["month"])][r["day"]] = r["prcp"]
    return data


def compute_distributions(monthly_data: dict) -> dict:
    """
    For each calendar month (1-12) and each day-of-month (0-30),
    compute the empirical distribution of remaining-period rainfall
    (from day+1 through end of month).

    Also compute unconditional monthly totals for base rate calculations.

    Returns a dict keyed by month (1-12) with:
      - days: dict keyed by day (0-30) with percentiles and gamma params
      - base_rates: {threshold: fraction}
      - monthly_totals_percentiles: percentiles of full-month totals
    """
    result = {}

    for month in range(1, 13):
        dim = DAYS_IN_MONTH[month]
        # For February, also include leap year data (day 29)
        if month == 2:
            dim = 29  # include leap day data

        # Collect all year-months for this calendar month
        year_months = [(y, m) for (y, m) in monthly_data.keys() if m == month]
        year_months.sort()

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
            # Remaining rainfall = sum from (current_day+1) through dim
            remaining_values = []
            for (y, m) in year_months:
                days_data = monthly_data[(y, m)]
                remaining = sum(days_data.get(d, 0.0) for d in range(current_day + 1, dim + 1))
                remaining_values.append(remaining)

            remaining_arr = np.array(remaining_values)

            # Percentiles
            percentiles = {}
            if len(remaining_arr) > 0:
                for p in [5, 10, 25, 50, 75, 90, 95]:
                    percentiles[str(p)] = round(float(np.percentile(remaining_arr, p)), 3)

            # Fit gamma distribution to remaining rainfall
            # Filter out zeros for fitting (gamma is defined on positive reals)
            # Store the fraction of zeros separately
            gamma_params = None
            positive_vals = remaining_arr[remaining_arr > 0]
            zero_fraction = float(np.mean(remaining_arr == 0))

            if len(positive_vals) >= 5:
                try:
                    # Fit gamma with floc=0 (force location to 0)
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

        # Also compute daily cumulative percentiles for the chart
        # For each day 1..dim, compute cumulative rainfall through that day
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
    output = {"stations": {}, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    for station_code, info in STATIONS.items():
        print(f"\nProcessing {station_code} ({info['city']})...")

        records = fetch_ghcn_data(info["ghcn_id"])
        if not records:
            print(f"  Skipping {station_code} - no data")
            continue

        monthly_data = organize_by_month_year(records)
        print(f"  Organized into {len(monthly_data)} station-months")

        distributions = compute_distributions(monthly_data)
        print(f"  Computed distributions for {len(distributions)} months")

        output["stations"][station_code] = {
            "city": info["city"],
            "ghcn_id": info["ghcn_id"],
            "months": distributions,
        }

    output_path = "public/data/historical-distributions.json"
    with open(output_path, "w") as f:
        json.dump(output, f)  # No indent to keep file size manageable

    # Also compute file size
    import os
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"\nOutput written to {output_path} ({size_mb:.1f} MB)")
    print("Done!")


if __name__ == "__main__":
    main()
