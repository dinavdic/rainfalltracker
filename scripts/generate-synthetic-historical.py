#!/usr/bin/env python3
"""
Generate realistic synthetic historical distributions for the rainfall tracker.

Since the NOAA GHCN-Daily API may not be accessible in all environments,
this script generates statistically realistic distributions based on known
climatological averages for each station. The output format is identical
to what build-historical-data.py would produce.

Run build-historical-data.py when you have access to the NOAA API to get
real data. This is a fallback for development/deployment.
"""

import json
import math
import time
import numpy as np
from scipy import stats

# Known average monthly precipitation (inches) from NOAA climate normals
# Source: 1991-2020 normals
STATION_MONTHLY_PRECIP = {
    "SFO": {
        "city": "San Francisco",
        "ghcn_id": "USW00023234",
        "monthly_avg": {
            1: 4.40, 2: 4.01, 3: 3.26, 4: 1.46, 5: 0.70, 6: 0.16,
            7: 0.02, 8: 0.06, 9: 0.21, 10: 1.04, 11: 2.49, 12: 4.00,
        },
    },
    "MIA": {
        "city": "Miami",
        "ghcn_id": "USW00012839",
        "monthly_avg": {
            1: 1.96, 2: 2.25, 3: 2.89, 4: 3.36, 5: 5.52, 6: 9.68,
            7: 6.50, 8: 8.63, 9: 9.84, 10: 6.34, 11: 3.27, 12: 2.08,
        },
    },
    "DEN": {
        "city": "Denver",
        "ghcn_id": "USW00023062",
        "monthly_avg": {
            1: 0.51, 2: 0.49, 3: 1.28, 4: 1.82, 5: 2.32, 6: 1.82,
            7: 2.16, 8: 1.82, 9: 1.14, 10: 0.99, 11: 0.73, 12: 0.63,
        },
    },
    "ORD": {
        "city": "Chicago",
        "ghcn_id": "USW00094846",
        "monthly_avg": {
            1: 2.05, 2: 1.95, 3: 2.56, 4: 3.60, 5: 4.13, 6: 4.10,
            7: 4.09, 8: 4.13, 9: 3.29, 10: 3.19, 11: 3.01, 12: 2.41,
        },
    },
    "JFK": {
        "city": "New York",
        "ghcn_id": "USW00094789",
        "monthly_avg": {
            1: 3.64, 2: 3.19, 3: 4.29, 4: 4.09, 5: 3.96, 6: 4.54,
            7: 4.60, 8: 4.44, 9: 4.31, 10: 3.85, 11: 3.65, 12: 3.98,
        },
    },
    "SEA": {
        "city": "Seattle",
        "ghcn_id": "USW00024233",
        "monthly_avg": {
            1: 5.57, 2: 3.59, 3: 3.75, 4: 2.77, 5: 2.16, 6: 1.57,
            7: 0.60, 8: 0.83, 9: 1.61, 10: 3.48, 11: 5.90, 12: 5.62,
        },
    },
}

DAYS_IN_MONTH = {1:31, 2:28, 3:31, 4:30, 5:31, 6:30, 7:31, 8:31, 9:30, 10:31, 11:30, 12:31}
THRESHOLDS = [1.0, 2.0, 3.0]
N_SIM_YEARS = 34  # 1991-2024


def generate_station_distributions(station_code: str, info: dict) -> dict:
    """Generate realistic distributions for one station."""
    np.random.seed(hash(station_code) % 2**32)

    months_result = {}

    for month in range(1, 13):
        dim = DAYS_IN_MONTH[month]
        avg_monthly = info["monthly_avg"][month]
        avg_daily = avg_monthly / dim

        # Simulate 34 years of daily data using a gamma distribution
        # Precipitation days have gamma-distributed amounts; many days are dry.
        # Probability of rain on any given day varies by station/month
        if avg_daily < 0.01:
            p_rain = 0.05
        elif avg_daily < 0.05:
            p_rain = 0.15
        elif avg_daily < 0.10:
            p_rain = 0.25
        elif avg_daily < 0.15:
            p_rain = 0.35
        else:
            p_rain = min(0.55, 0.25 + avg_daily * 1.5)

        # Gamma shape/scale for wet-day amounts
        wet_day_mean = avg_daily / p_rain
        gamma_shape_daily = 0.7  # typical for daily precip
        gamma_scale_daily = wet_day_mean / gamma_shape_daily

        # Simulate daily data: N_SIM_YEARS years
        daily_data = np.zeros((N_SIM_YEARS, dim))
        for y in range(N_SIM_YEARS):
            for d in range(dim):
                if np.random.random() < p_rain:
                    daily_data[y, d] = np.random.gamma(gamma_shape_daily, gamma_scale_daily)

        # Monthly totals
        monthly_totals = daily_data.sum(axis=1)

        # Base rates
        base_rates = {}
        for thresh in THRESHOLDS:
            frac = float(np.mean(monthly_totals > thresh))
            base_rates[str(thresh)] = round(frac, 4)

        # Monthly total percentiles
        month_percentiles = {}
        for p in [5, 10, 25, 50, 75, 90, 95]:
            month_percentiles[str(p)] = round(float(np.percentile(monthly_totals, p)), 3)

        # Remaining-period distributions for each current_day
        days_result = {}
        for current_day in range(0, dim):
            # Remaining = sum from column current_day to dim-1 (i.e., day current_day+1 through end)
            remaining = daily_data[:, current_day:].sum(axis=1) if current_day < dim else np.zeros(N_SIM_YEARS)
            if current_day > 0:
                remaining = daily_data[:, current_day:].sum(axis=1)
            else:
                remaining = monthly_totals.copy()

            # Percentiles
            percentiles = {}
            for p in [5, 10, 25, 50, 75, 90, 95]:
                percentiles[str(p)] = round(float(np.percentile(remaining, p)), 3)

            # Fit gamma
            gamma_params = None
            positive_vals = remaining[remaining > 0]
            zero_fraction = float(np.mean(remaining == 0))

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
                "n_years": N_SIM_YEARS,
                "mean": round(float(np.mean(remaining)), 3),
            }

        # Cumulative percentiles for chart
        cumulative_percentiles = {}
        for day_num in range(1, dim + 1):
            cum = daily_data[:, :day_num].sum(axis=1)
            cumulative_percentiles[str(day_num)] = {
                "p10": round(float(np.percentile(cum, 10)), 3),
                "p25": round(float(np.percentile(cum, 25)), 3),
                "p50": round(float(np.percentile(cum, 50)), 3),
                "p75": round(float(np.percentile(cum, 75)), 3),
                "p90": round(float(np.percentile(cum, 90)), 3),
            }

        months_result[str(month)] = {
            "days_in_month": dim,
            "days": days_result,
            "base_rates": base_rates,
            "monthly_totals_percentiles": month_percentiles,
            "cumulative_percentiles": cumulative_percentiles,
        }

    return {
        "city": info["city"],
        "ghcn_id": info["ghcn_id"],
        "months": months_result,
    }


def main():
    output = {
        "stations": {},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "Synthetic data based on climatological normals. Re-run build-historical-data.py with NOAA API access for real data.",
    }

    for station_code, info in STATION_MONTHLY_PRECIP.items():
        print(f"Generating distributions for {station_code} ({info['city']})...")
        output["stations"][station_code] = generate_station_distributions(station_code, info)

    output_path = "public/data/historical-distributions.json"
    with open(output_path, "w") as f:
        json.dump(output, f)

    import os
    size_kb = os.path.getsize(output_path) / 1024
    print(f"\nOutput written to {output_path} ({size_kb:.0f} KB)")
    print("Done!")


if __name__ == "__main__":
    main()
