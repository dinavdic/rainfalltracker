#!/usr/bin/env python3
"""
Patch existing historical-distributions.json to add ENSO-conditional fields.

Adds null gamma_nino/gamma_nina/gamma_neutral and empty base_rates_* to each
day/month so the frontend TypeScript types are satisfied. The probability
engine falls back to unconditional distributions when ENSO fields are null.

Run the full build-historical-data.py with network access to populate real
ENSO-conditional distributions.
"""

import json
import os

INPUT_PATH = os.path.join(os.path.dirname(__file__), "..", "public", "data", "historical-distributions.json")

def main():
    with open(INPUT_PATH) as f:
        data = json.load(f)

    for station_code, station_data in data["stations"].items():
        for month_key, month_data in station_data["months"].items():
            # Add ENSO base rates (empty → fallback to unconditional)
            if "base_rates_nino" not in month_data:
                month_data["base_rates_nino"] = {}
            if "base_rates_nina" not in month_data:
                month_data["base_rates_nina"] = {}
            if "base_rates_neutral" not in month_data:
                month_data["base_rates_neutral"] = {}

            # Add ENSO gamma fields to each day
            for day_key, day_data in month_data["days"].items():
                if "gamma_nino" not in day_data:
                    day_data["gamma_nino"] = None
                if "gamma_nina" not in day_data:
                    day_data["gamma_nina"] = None
                if "gamma_neutral" not in day_data:
                    day_data["gamma_neutral"] = None

    # Also add 6.0 and 7.0 thresholds to base_rates if missing
    for station_code, station_data in data["stations"].items():
        for month_key, month_data in station_data["months"].items():
            for thresh in ["6.0", "7.0"]:
                if thresh not in month_data["base_rates"]:
                    month_data["base_rates"][thresh] = 0.0

    data["enso_conditioned"] = True

    with open(INPUT_PATH, "w") as f:
        json.dump(data, f)

    size_kb = os.path.getsize(INPUT_PATH) / 1024
    print(f"Patched {INPUT_PATH} ({size_kb:.0f} KB)")
    print("ENSO fields added (null/empty — will fall back to unconditional).")
    print("Run build-historical-data.py with network access for real ENSO data.")

if __name__ == "__main__":
    main()
