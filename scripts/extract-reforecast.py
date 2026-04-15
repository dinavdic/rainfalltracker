#!/usr/bin/env python3
"""
Extract NOAA GEFSv12 reforecast precipitation for our 10 stations.

For every April day from 2000 through 2019, downloads the accumulated
surface precipitation GRIB2 file for each of the 5 reforecast ensemble
members (c00, p01..p04) from the public

    s3://noaa-gefs-retrospective/GEFSv12/reforecast/

bucket, samples the nearest grid point to each station, and writes the
per-day precip totals (inches) to

    scripts/.reforecast-cache/{station}/{YYYY-MM-DD}.json

as

    {
      "issue_date": "YYYY-MM-DD",
      "station": "DEN",
      "lead_days": 10,
      "grid_point": {"lat": ..., "lon": ...},
      "members": [[d1, d2, ..., d10],  ...]   // 5 lists, one per member
    }

The extraction is resumable — if the cache file already exists for a
given (station, issue_date), that date is skipped entirely (no S3
download). Pass `--station DEN --year 2019` to process a single
station-year quickly for validation before a full run.

Requires: xarray, cfgrib (+ eccodes C library), s3fs.
"""

import argparse
import json
import os
import sys
import tempfile
import time
import warnings
from datetime import date

# --- Paths / constants -------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(SCRIPT_DIR, ".reforecast-cache")

STATIONS = [
    {"code": "SFO", "lat": 37.6213, "lon": -122.379},
    {"code": "LAX", "lat": 33.9425, "lon": -118.4081},
    {"code": "MIA", "lat": 25.7617, "lon": -80.1918},
    {"code": "DEN", "lat": 39.8561, "lon": -104.6737},
    {"code": "MDW", "lat": 41.7868, "lon": -87.7522},
    {"code": "NYC", "lat": 40.7829, "lon": -73.9654},
    {"code": "SEA", "lat": 47.4502, "lon": -122.3088},
    {"code": "AUS", "lat": 30.1945, "lon": -97.6699},
    {"code": "DFW", "lat": 32.8998, "lon": -97.0403},
    {"code": "HOU", "lat": 29.6454, "lon": -95.2789},
]

MEMBERS = ["c00", "p01", "p02", "p03", "p04"]
BUCKET = "noaa-gefs-retrospective"
PREFIX = "GEFSv12/reforecast"
DAYS_GROUP = "Days:1-10"
NUM_DAYS = 10
YEARS = range(2000, 2020)
MONTH = 4  # April
S3_DELAY_SEC = 0.5


# --- Dependency handling -----------------------------------------------------

def _check_deps() -> None:
    """Import heavy deps up-front with a helpful error if any are missing."""
    missing: list[str] = []
    for mod in ("xarray", "cfgrib", "s3fs", "numpy"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(
            f"ERROR: missing required Python packages: {', '.join(missing)}\n"
            f"Install with: pip install xarray cfgrib s3fs numpy\n"
            f"cfgrib additionally needs the eccodes C library "
            f"(e.g. `apt install libeccodes0` or `brew install eccodes`).",
            file=sys.stderr,
        )
        sys.exit(1)


# --- S3 access with throttling ----------------------------------------------

_fs = None
_last_s3_call = 0.0


def _s3fs():
    global _fs
    if _fs is None:
        import s3fs  # type: ignore
        _fs = s3fs.S3FileSystem(anon=True)
    return _fs


def _throttle() -> None:
    global _last_s3_call
    elapsed = time.time() - _last_s3_call
    if elapsed < S3_DELAY_SEC:
        time.sleep(S3_DELAY_SEC - elapsed)
    _last_s3_call = time.time()


def grib_s3_key(issue_date: date, member: str) -> str:
    """Build the S3 object key for an apcp_sfc reforecast file.

    Example:
      GEFSv12/reforecast/2019/2019040100/c00/Days:1-10/apcp_sfc_2019040100_c00.grib2
    """
    yyyymmdd = issue_date.strftime("%Y%m%d")
    fname = f"apcp_sfc_{yyyymmdd}00_{member}.grib2"
    return (
        f"{BUCKET}/{PREFIX}/{issue_date.year}/{yyyymmdd}00/"
        f"{member}/{DAYS_GROUP}/{fname}"
    )


def download_grib(issue_date: date, member: str, dest_dir: str) -> str:
    fs = _s3fs()
    key = grib_s3_key(issue_date, member)
    local = os.path.join(dest_dir, f"{member}.grib2")
    _throttle()
    fs.get(key, local)
    return local


# --- GRIB extraction ---------------------------------------------------------

def extract_station_daily(ds, station_lat: float, station_lon: float) -> list:
    """Return NUM_DAYS daily precip totals (inches) for a station's
    nearest grid point. Entries may be None if a given day's step wasn't
    found in the file (shouldn't happen for a well-formed reforecast
    file, but we guard against it).

    GEFSv12 apcp is accumulated precipitation from forecast initialization,
    so daily totals are obtained by differencing cumulative values at
    24-hour step marks.
    """
    import numpy as np  # type: ignore

    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"

    lon_max = float(ds[lon_name].max())
    if lon_max > 180 and station_lon < 0:
        lon_use = station_lon + 360
    else:
        lon_use = station_lon

    # Pick the precip variable (cfgrib typically names apcp as 'tp').
    preferred = [v for v in ds.data_vars if v in ("tp", "apcp", "acpcp")]
    var = preferred[0] if preferred else list(ds.data_vars)[0]
    da = ds[var].sel({lat_name: station_lat, lon_name: lon_use}, method="nearest")

    # step coord is usually timedelta64[ns]; sometimes int hours.
    if "step" in da.coords:
        step = np.atleast_1d(da.step.values)
        if np.issubdtype(step.dtype, np.timedelta64):
            step_hours = step.astype("timedelta64[h]").astype(int)
        else:
            step_hours = step.astype(int)
    else:
        return [None] * NUM_DAYS

    vals = np.atleast_1d(da.values).astype(float)

    cum_by_day: dict[int, float] = {0: 0.0}
    for i, h in enumerate(step_hours):
        hi = int(h)
        if hi < 0 or hi > NUM_DAYS * 24:
            continue
        if hi % 24 == 0 and i < len(vals):
            cum_by_day[hi // 24] = float(vals[i])

    daily: list = []
    for d in range(1, NUM_DAYS + 1):
        if d not in cum_by_day or (d - 1) not in cum_by_day:
            daily.append(None)
            continue
        mm = cum_by_day[d] - cum_by_day[d - 1]
        if mm < 0:  # defensive — accumulator shouldn't decrease
            mm = 0.0
        daily.append(round(mm / 25.4, 4))
    return daily


def grid_point_for(ds, station_lat: float, station_lon: float) -> dict:
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    lon_max = float(ds[lon_name].max())
    lon_use = station_lon + 360 if (lon_max > 180 and station_lon < 0) else station_lon
    sel = ds.sel({lat_name: station_lat, lon_name: lon_use}, method="nearest")
    return {
        "lat": round(float(sel[lat_name].values), 4),
        "lon": round(float(sel[lon_name].values), 4),
    }


# --- Cache helpers -----------------------------------------------------------

def cache_path(station_code: str, issue_date: date) -> str:
    return os.path.join(CACHE_DIR, station_code, f"{issue_date.isoformat()}.json")


def is_cached(station_code: str, issue_date: date) -> bool:
    return os.path.exists(cache_path(station_code, issue_date))


def save_cache(station_code: str, issue_date: date, payload: dict) -> None:
    p = cache_path(station_code, issue_date)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(payload, f)


# --- Per-issue-date processing ----------------------------------------------

def process_issue_date(issue_date: date, stations: list[dict]) -> int:
    """Fetch all 5 members, extract each pending station, cache results.
    Returns the number of newly-cached (station, date) records.
    """
    pending = [s for s in stations if not is_cached(s["code"], issue_date)]
    if not pending:
        print(f"[{issue_date}] all cached, skipping", flush=True)
        return 0

    import xarray as xr  # type: ignore

    start = time.time()
    print(
        f"[{issue_date}] fetching {len(MEMBERS)} members "
        f"for {len(pending)} station(s)…",
        flush=True,
    )

    # extracted[code] = list of per-member daily arrays (5 lists of NUM_DAYS)
    extracted: dict[str, list] = {s["code"]: [] for s in pending}
    grid_info: dict[str, dict | None] = {s["code"]: None for s in pending}

    with tempfile.TemporaryDirectory(prefix="gefsv12_") as tmp:
        for member in MEMBERS:
            try:
                local = download_grib(issue_date, member, tmp)
            except Exception as e:
                print(f"  [warn] {member} download failed: {e}", file=sys.stderr)
                for s in pending:
                    extracted[s["code"]].append([None] * NUM_DAYS)
                continue

            try:
                # indexpath='' disables sidecar .idx file caching, which
                # keeps temp dirs self-contained and avoids permission
                # issues in sandboxed environments.
                ds = xr.open_dataset(
                    local,
                    engine="cfgrib",
                    backend_kwargs={"indexpath": ""},
                )
            except Exception as e:
                print(f"  [warn] {member} open failed: {e}", file=sys.stderr)
                for s in pending:
                    extracted[s["code"]].append([None] * NUM_DAYS)
                continue

            for s in pending:
                try:
                    daily = extract_station_daily(ds, s["lat"], s["lon"])
                    extracted[s["code"]].append(daily)
                    if grid_info[s["code"]] is None:
                        grid_info[s["code"]] = grid_point_for(ds, s["lat"], s["lon"])
                except Exception as e:
                    print(
                        f"  [warn] {member} extract {s['code']} failed: {e}",
                        file=sys.stderr,
                    )
                    extracted[s["code"]].append([None] * NUM_DAYS)

            ds.close()

    for s in pending:
        payload = {
            "issue_date": issue_date.isoformat(),
            "station": s["code"],
            "lead_days": NUM_DAYS,
            "grid_point": grid_info[s["code"]],
            "members": extracted[s["code"]],
        }
        save_cache(s["code"], issue_date, payload)

    elapsed = time.time() - start
    print(f"  done in {elapsed:.1f}s — cached {len(pending)} station(s)", flush=True)
    return len(pending)


# --- Main --------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument(
        "--station",
        help="Only process a single station code (e.g. DEN). Default: all 10.",
    )
    ap.add_argument(
        "--year",
        type=int,
        help="Only process a single year. Default: every year 2000-2019.",
    )
    args = ap.parse_args()

    _check_deps()

    # cfgrib is chatty about metadata quirks that don't affect our reads.
    warnings.filterwarnings("ignore", category=UserWarning, module="cfgrib")

    stations = STATIONS
    if args.station:
        stations = [s for s in STATIONS if s["code"] == args.station]
        if not stations:
            print(f"Unknown station: {args.station}", file=sys.stderr)
            return 1

    years = [args.year] if args.year else list(YEARS)
    for y in years:
        if y < 2000 or y > 2019:
            print(
                f"Warning: year {y} is outside the GEFSv12 reforecast range "
                f"(2000–2019); expect 404s.",
                file=sys.stderr,
            )

    os.makedirs(CACHE_DIR, exist_ok=True)

    total_new = 0
    total_dates = 0
    for y in years:
        for d in range(1, 31):  # April has 30 days
            issue = date(y, MONTH, d)
            total_dates += 1
            total_new += process_issue_date(issue, stations)

    print(
        f"\nDone. Processed {total_dates} date(s); "
        f"cached {total_new} new (station, date) extraction(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
