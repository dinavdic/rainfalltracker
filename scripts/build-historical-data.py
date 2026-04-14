#!/usr/bin/env python3
"""
Historical rainfall data pipeline using IEM CLI JSON archive.

Downloads daily precipitation data from the Iowa Environmental Mesonet (IEM)
CLI JSON endpoint for 10 US stations (1991-2024). This data matches the exact
NWS CLI reports used for Kalshi settlement.

IEM CLI JSON endpoint: https://mesonet.agron.iastate.edu/json/cli.py?station=KSFO&year=2024

Station codes use the K prefix (KSFO, KMIA, etc.).
Data is fetched one year at a time. Each response contains a "results" array
with entries having: valid (date), precip (daily inches), precip_month (MTD).
Values of "M" indicate missing data.

Computes empirical distributions of remaining-period rainfall for each
station-month-day combination, fits gamma distributions, and outputs a JSON
file for the frontend.
"""

import json
import os
import time
import math
from collections import defaultdict
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
import numpy as np
from scipy import stats

# Station codes match Kalshi settlement stations.
# IEM JSON endpoint requires K-prefixed ICAO codes.
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
END_YEAR = 2024
THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]

DAYS_IN_MONTH = {1:31, 2:28, 3:31, 4:30, 5:31, 6:30, 7:31, 8:31, 9:30, 10:31, 11:30, 12:31}

# ENSO year classifications (from NOAA ONI)
ENSO_YEARS_PATH = os.path.join(os.path.dirname(__file__), "..", "public", "data", "enso-years.json")

def load_enso_years() -> dict[int, str]:
    """Load ENSO classification for each year."""
    with open(ENSO_YEARS_PATH) as f:
        raw = json.load(f)
    return {int(k): v for k, v in raw.items()}

ENSO_PHASES = ["nino", "nina", "neutral"]


def fetch_iem_year(icao: str, year: int) -> list[dict]:
    """Fetch one year of CLI data from the IEM JSON endpoint."""
    url = f"{IEM_BASE}?station={icao}&year={year}"

    for attempt in range(5):
        try:
            req = Request(url, headers={
                "User-Agent": "RainfallTracker/1.0 (contact@example.com)"
            })
            with urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            break
        except (URLError, HTTPError, TimeoutError) as e:
            wait = 2 ** (attempt + 1)
            print(f"    Attempt {attempt+1} failed ({e}), retrying in {wait}s...")
            time.sleep(wait)
        except json.JSONDecodeError as e:
            print(f"    JSON decode error for {year}: {e}")
            return []
    else:
        print(f"    FAILED to fetch {icao} year {year} after 5 attempts")
        return []

    results = data.get("results", [])
    records = []
    for entry in results:
        try:
            date_str = entry.get("valid", "")
            precip_val = entry.get("precip")

            if not date_str:
                continue

            # "M" means missing
            if precip_val is None or precip_val == "M":
                continue

            # "T" (trace, < 0.005") is a valid near-zero observation,
            # not missing data — treat as 0.0 so arid stations keep
            # their full record of dry days.
            if precip_val == "T":
                prcp = 0.0
            else:
                prcp = float(precip_val)
                if prcp < 0:
                    prcp = 0.0

            y, m, d = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
            records.append({"year": y, "month": m, "day": d, "prcp": prcp})
        except (ValueError, TypeError, IndexError):
            continue

    return records


def fetch_iem_cli_data(icao: str) -> list[dict]:
    """Download all years of CLI data for a station."""
    all_records = []
    for year in range(START_YEAR, END_YEAR + 1):
        records = fetch_iem_year(icao, year)
        all_records.extend(records)
        if year % 10 == 0 or year == END_YEAR:
            print(f"    {year}: {len(records)} days (total so far: {len(all_records)})")
        # Small delay to be polite to the IEM server
        time.sleep(0.2)

    print(f"  Total: {len(all_records)} daily records")
    return all_records


def organize_by_month_year(records: list[dict]) -> dict:
    """Organize records into {(year, month): {day: prcp}}."""
    data = defaultdict(dict)
    for r in records:
        data[(r["year"], r["month"])][r["day"]] = r["prcp"]
    return data


def fit_gamma(values_arr: np.ndarray) -> dict | None:
    """Fit a zero-inflated gamma distribution. Returns params or None."""
    positive_vals = values_arr[values_arr > 0]
    zero_fraction = float(np.mean(values_arr == 0))

    if len(positive_vals) >= 5:
        try:
            shape, loc, scale = stats.gamma.fit(positive_vals, floc=0)
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
    """Compute exceedance rates for each threshold."""
    rates = {}
    for thresh in THRESHOLDS:
        frac = float(np.mean(totals_arr > thresh))
        rates[str(thresh)] = round(frac, 4)
    return rates


def compute_distributions(monthly_data: dict, enso_years: dict[int, str]) -> dict:
    """
    For each calendar month (1-12) and each day-of-month (0 through dim-1),
    compute the empirical distribution of remaining-period rainfall
    (from day+1 through end of month).

    Computes both unconditional (all years) and ENSO-conditional
    (El Niño, La Niña, Neutral) distributions.

    Returns a dict keyed by month (1-12) with:
      - days: dict keyed by day (0 through dim-1) with percentiles and gamma params
      - base_rates: {threshold: fraction}  (unconditional)
      - base_rates_nino, base_rates_nina, base_rates_neutral: ENSO-conditional
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

        # Partition year-months by ENSO phase
        enso_year_months = {phase: [] for phase in ENSO_PHASES}
        for (y, m) in year_months:
            phase = enso_years.get(y, "neutral")
            enso_year_months[phase].append((y, m))

        # Compute full-month totals for base rates (all years)
        monthly_totals = []
        for (y, m) in year_months:
            days_data = monthly_data[(y, m)]
            total = sum(days_data.get(d, 0.0) for d in range(1, dim + 1))
            monthly_totals.append(total)

        monthly_totals_arr = np.array(monthly_totals)
        base_rates = compute_base_rates(monthly_totals_arr)

        # ENSO-conditional base rates
        enso_base_rates = {}
        for phase in ENSO_PHASES:
            phase_totals = []
            for (y, m) in enso_year_months[phase]:
                days_data = monthly_data[(y, m)]
                total = sum(days_data.get(d, 0.0) for d in range(1, dim + 1))
                phase_totals.append(total)
            if phase_totals:
                enso_base_rates[phase] = compute_base_rates(np.array(phase_totals))
            else:
                enso_base_rates[phase] = {}

        month_percentiles = {}
        if len(monthly_totals_arr) > 0:
            for p in [5, 10, 25, 50, 75, 90, 95]:
                month_percentiles[str(p)] = round(float(np.percentile(monthly_totals_arr, p)), 3)

        # For each possible "current day" (0 = start of month, 1 = after day 1, etc.)
        days_result = {}
        for current_day in range(0, dim):
            # Compute remaining-period values for all years
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

            # Unconditional gamma fit
            gamma_params = fit_gamma(remaining_arr)

            # ENSO-conditional gamma fits
            enso_gamma = {}
            for phase in ENSO_PHASES:
                phase_remaining = []
                for (y, m) in enso_year_months[phase]:
                    days_data = monthly_data[(y, m)]
                    remaining = sum(days_data.get(d, 0.0) for d in range(current_day + 1, dim + 1))
                    phase_remaining.append(remaining)
                if phase_remaining:
                    enso_gamma[phase] = fit_gamma(np.array(phase_remaining))
                else:
                    enso_gamma[phase] = None

            day_entry = {
                "percentiles": percentiles,
                "gamma": gamma_params,
                "gamma_nino": enso_gamma.get("nino"),
                "gamma_nina": enso_gamma.get("nina"),
                "gamma_neutral": enso_gamma.get("neutral"),
                "n_years": len(remaining_values),
                "mean": round(float(np.mean(remaining_arr)), 3),
            }

            days_result[str(current_day)] = day_entry

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
            "base_rates_nino": enso_base_rates.get("nino", {}),
            "base_rates_nina": enso_base_rates.get("nina", {}),
            "base_rates_neutral": enso_base_rates.get("neutral", {}),
            "monthly_totals_percentiles": month_percentiles,
            "cumulative_percentiles": cumulative_percentiles,
        }

    return result


def main():
    enso_years = load_enso_years()
    print(f"Loaded ENSO classifications for {len(enso_years)} years")
    for phase in ENSO_PHASES:
        years = [y for y, p in enso_years.items() if p == phase]
        print(f"  {phase}: {len(years)} years ({', '.join(str(y) for y in sorted(years))})")

    output = {
        "stations": {},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "IEM CLI JSON Archive (mesonet.agron.iastate.edu/json/cli.py)",
        "enso_conditioned": True,
    }

    for station_code, info in STATIONS.items():
        print(f"\nProcessing {station_code} ({info['city']}, ICAO: {info['icao']})...")

        records = fetch_iem_cli_data(info["icao"])
        if not records:
            print(f"  Skipping {station_code} - no data")
            continue

        monthly_data = organize_by_month_year(records)
        print(f"  Organized into {len(monthly_data)} station-months")

        distributions = compute_distributions(monthly_data, enso_years)
        print(f"  Computed distributions for {len(distributions)} months")

        output["stations"][station_code] = {
            "city": info["city"],
            "iem_code": info["icao"],
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
