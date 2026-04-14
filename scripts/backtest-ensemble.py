#!/usr/bin/env python3
"""
Backtest our probability engine against archived GEFS forecasts.

For each day in April 2024 and April 2025, for each of our 10 stations:
  - Fetch the archived GEFS ensemble (gfs_seamless) from Open-Meteo's
    historical forecast API for a 16-day window starting that date.
  - Compute MTD rainfall through the prior day from IEM daily actuals.
  - Run the same probability logic as the live system: skill-weighted,
    deviation-preserving blend of ensemble members with climatological
    gamma distributions from public/data/historical-distributions.json.
  - Record the predicted P(exceed) for each threshold (1-7 inches).

After each April ends, the actual month total is known from IEM and we
score predictions as binary outcomes (did the monthly total exceed the
threshold?). We compute:
  - Brier score per station
  - Reliability-diagram bins (10 deciles of predicted probability)
  - Brier skill score vs. the day-of-month climatological gamma

Results are written to public/data/backtest-results.json.

Open-Meteo requests are throttled to one every 500ms and cached under
scripts/.backtest-cache/ keyed by (station, issue date), so re-runs are
effectively instant after the initial fetch.
"""

import json
import math
import os
import sys
import time
from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from scipy import stats

# --- Paths ---

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
PUBLIC_DATA = os.path.join(REPO_ROOT, "public", "data")
CACHE_DIR = os.path.join(SCRIPT_DIR, ".backtest-cache")

HIST_PATH = os.path.join(PUBLIC_DATA, "historical-distributions.json")
SKILL_PATH = os.path.join(PUBLIC_DATA, "skill-curves.json")
ENSO_PATH = os.path.join(PUBLIC_DATA, "enso-years.json")
OUT_PATH = os.path.join(PUBLIC_DATA, "backtest-results.json")

# --- Station config (mirrors src/lib/stations.ts) ---

STATIONS = [
    {"code": "SFO", "city": "San Francisco",    "icao": "KSFO", "lat": 37.6213, "lon": -122.379},
    {"code": "LAX", "city": "Los Angeles",       "icao": "KLAX", "lat": 33.9425, "lon": -118.4081},
    {"code": "MIA", "city": "Miami",             "icao": "KMIA", "lat": 25.7617, "lon": -80.1918},
    {"code": "DEN", "city": "Denver",            "icao": "KDEN", "lat": 39.8561, "lon": -104.6737},
    {"code": "MDW", "city": "Chicago",           "icao": "KMDW", "lat": 41.7868, "lon": -87.7522},
    {"code": "NYC", "city": "New York",          "icao": "KNYC", "lat": 40.7829, "lon": -73.9654},
    {"code": "SEA", "city": "Seattle",           "icao": "KSEA", "lat": 47.4502, "lon": -122.3088},
    {"code": "AUS", "city": "Austin",            "icao": "KAUS", "lat": 30.1945, "lon": -97.6699},
    {"code": "DFW", "city": "Dallas-Fort Worth", "icao": "KDFW", "lat": 32.8998, "lon": -97.0403},
    {"code": "HOU", "city": "Houston",           "icao": "KHOU", "lat": 29.6454, "lon": -95.2789},
]

THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]

# Test both April 2024 and April 2025
BACKTEST_MONTHS = [(2024, 4), (2025, 4)]

OPEN_METEO_HISTORICAL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
IEM_JSON_BASE = "https://mesonet.agron.iastate.edu/json/cli.py"
USER_AGENT = "RainfallTracker-Backtest/1.0 (rainfall-tracker@example.com)"

OPEN_METEO_DELAY_SEC = 0.5  # 500ms between Open-Meteo calls
FORECAST_DAYS = 16

# One-time guard so we only warn once if the archive endpoint returns the
# deterministic precipitation series instead of ensemble members.
_warned_deterministic = False


# --- HTTP helpers with rate limiting and on-disk cache ---

_last_open_meteo_call = 0.0


def _throttle_open_meteo() -> None:
    global _last_open_meteo_call
    elapsed = time.time() - _last_open_meteo_call
    if elapsed < OPEN_METEO_DELAY_SEC:
        time.sleep(OPEN_METEO_DELAY_SEC - elapsed)
    _last_open_meteo_call = time.time()


def _cache_path(station_code: str, issue_date: date) -> str:
    return os.path.join(CACHE_DIR, station_code, f"{issue_date.isoformat()}.json")


def _load_cache(station_code: str, issue_date: date):
    path = _cache_path(station_code, issue_date)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
    return None


def _save_cache(station_code: str, issue_date: date, data: dict) -> None:
    path = _cache_path(station_code, issue_date)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


def http_get_json(url: str, timeout: int = 30) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_open_meteo_forecast(station: dict, issue_date: date) -> dict | None:
    """Fetch archived GEFS forecast issued on `issue_date`, covering
    `issue_date` through `issue_date + FORECAST_DAYS - 1`.

    Returns the raw JSON (with an `hourly` block) or None on failure.
    Cached on disk; rate-limited across cache misses.
    """
    cached = _load_cache(station["code"], issue_date)
    if cached is not None:
        return cached

    end = issue_date + timedelta(days=FORECAST_DAYS - 1)
    params = {
        "latitude": station["lat"],
        "longitude": station["lon"],
        "start_date": issue_date.isoformat(),
        "end_date": end.isoformat(),
        "hourly": "precipitation",
        "models": "gfs_seamless",
    }
    url = f"{OPEN_METEO_HISTORICAL}?{urlencode(params)}"

    _throttle_open_meteo()
    try:
        data = http_get_json(url, timeout=30)
    except (HTTPError, URLError, TimeoutError) as e:
        print(f"  [warn] Open-Meteo fetch failed for {station['code']} {issue_date}: {e}",
              file=sys.stderr)
        return None

    _save_cache(station["code"], issue_date, data)
    return data


# --- IEM daily actuals ---

def fetch_iem_year(icao: str, year: int) -> list[dict]:
    url = f"{IEM_JSON_BASE}?station={icao}&year={year}"
    data = http_get_json(url, timeout=30)
    return data.get("results", []) or []


def build_daily_precip(year: int, icao: str) -> dict[str, float]:
    """Return {YYYY-MM-DD: daily_precip_inches} for the calendar year.
    Missing / "T" (trace) / "M" values are treated as 0.0.
    """
    out: dict[str, float] = {}
    results = fetch_iem_year(icao, year)
    for entry in results:
        dstr = entry.get("valid")
        if not dstr:
            continue
        raw = entry.get("precip")
        if raw is None or raw == "M":
            continue
        if isinstance(raw, str):
            if raw.strip().upper() == "T":
                val = 0.0
            else:
                try:
                    val = float(raw)
                except ValueError:
                    continue
        else:
            try:
                val = float(raw)
            except (TypeError, ValueError):
                continue
        out[dstr] = val
    return out


def mtd_through(daily: dict[str, float], year: int, month: int, through_day: int) -> float:
    """Sum daily precip from day 1 through `through_day` (inclusive).
    `through_day` of 0 means no days have elapsed yet → MTD = 0.
    """
    if through_day <= 0:
        return 0.0
    total = 0.0
    for d in range(1, through_day + 1):
        key = f"{year:04d}-{month:02d}-{d:02d}"
        total += daily.get(key, 0.0)
    return total


def month_total(daily: dict[str, float], year: int, month: int) -> float:
    dim = monthrange(year, month)[1]
    return sum(daily.get(f"{year:04d}-{month:02d}-{d:02d}", 0.0) for d in range(1, dim + 1))


# --- Historical distributions / gamma survival ---

def load_historical() -> dict:
    with open(HIST_PATH) as f:
        return json.load(f)


def load_skill_curves() -> dict:
    with open(SKILL_PATH) as f:
        return json.load(f)


def load_enso_years() -> dict[int, str]:
    with open(ENSO_PATH) as f:
        raw = json.load(f)
    return {int(k): v for k, v in raw.items()}


def build_daily_climo_mean(hist: dict) -> dict[str, dict[str, float]]:
    """Mirror loadClimoDailyMean() in fetch-rainfall/route.ts.

    climo[station]["MM-DD"] = single-day climatological mean precip
        = max(0, days[d-1].mean - days[d].mean)
    where days[d].mean is the mean remaining-month precip from day d onward.
    """
    out: dict[str, dict[str, float]] = {}
    for code, sdata in hist["stations"].items():
        daily: dict[str, float] = {}
        for month_str, mdata in sdata["months"].items():
            month = int(month_str)
            dim = mdata["days_in_month"]
            for d in range(1, dim + 1):
                prev_mean = (mdata["days"].get(str(d - 1)) or {}).get("mean", 0.0)
                curr_mean = (mdata["days"].get(str(d)) or {}).get("mean", 0.0)
                single = max(0.0, prev_mean - curr_mean)
                daily[f"{month:02d}-{d:02d}"] = round(single, 4)
        out[code] = daily
    return out


def get_enso_gamma(day_dist: dict | None, enso_phase: str | None) -> dict | None:
    """Fetch ENSO-conditional gamma, falling back to unconditional if null."""
    if not day_dist:
        return None
    if enso_phase is None:
        return day_dist.get("gamma")
    cond = day_dist.get(f"gamma_{enso_phase}")
    return cond if cond is not None else day_dist.get("gamma")


def gamma_survival(x: float, params: dict) -> float:
    """P(X > x) under a zero-inflated gamma, matching gammaSurvival() in probability.ts.

    jStat's gamma.cdf takes (shape, scale); scipy.stats.gamma uses
    (a=shape, scale=scale), so we pass them positionally.
    """
    zf = params["zero_fraction"]
    if x <= 0:
        return 1 - zf
    cdf = stats.gamma.cdf(x, params["shape"], scale=params["scale"])
    return (1 - zf) * (1 - cdf)


def get_skill_weight(skill: dict, station_code: str, lead_day: int) -> float:
    """Accumulated-skill fitted weight for a given 1-indexed lead day."""
    if not skill or station_code not in skill:
        return 1.0
    fitted = skill[station_code]["accumulated_skill"]["fitted"]
    idx = min(max(lead_day - 1, 0), len(fitted) - 1)
    return float(fitted[idx])


# --- Ensemble parsing & skill-weighted blending ---

def parse_ensemble(
    om_data: dict,
    issue_date: date,
    station_code: str,
    skill: dict,
    climo_daily: dict[str, float],
    month_end: date,
) -> tuple[list[float], int]:
    """Collapse Open-Meteo hourly output into per-member daily totals,
    apply the live system's deviation-preserving skill blend, and return
    per-member sums (in inches) over the rest of the current month plus
    the number of forecast days covered within the month.

    If the API returned precipitation_member* keys we use them as the
    ensemble; otherwise we fall back to the deterministic `precipitation`
    series as a single-member degenerate ensemble.
    """
    hourly = om_data.get("hourly") or {}
    times: list[str] = hourly.get("time") or []
    if not times:
        return [], 0

    member_keys = sorted(
        [k for k in hourly.keys() if k.startswith("precipitation_member")],
        key=lambda k: int(k.replace("precipitation_member", "")),
    )
    if not member_keys:
        if "precipitation" in hourly:
            global _warned_deterministic
            if not _warned_deterministic:
                print(
                    "  [note] Open-Meteo archive returned no precipitation_member* "
                    "keys — falling back to the deterministic `precipitation` "
                    "series as a single-member ensemble. Scores below reflect a "
                    "deterministic GEFS forecast, not a true ensemble.",
                    file=sys.stderr,
                )
                _warned_deterministic = True
            member_keys = ["precipitation"]
        else:
            return [], 0

    # "now" for the backtest = start of the issue date; we count every
    # forecast hour that lands between issue_date (inclusive) and the
    # first of the next month (exclusive).
    now = datetime(issue_date.year, issue_date.month, issue_date.day)
    monthend_dt = datetime(month_end.year, month_end.month, month_end.day)

    # Group hour indices by calendar date, tracking lead day from issue date.
    day_buckets: list[dict] = []
    seen: dict[str, int] = {}
    last_valid: datetime | None = None
    for i, tstr in enumerate(times):
        try:
            t = datetime.fromisoformat(tstr)
        except ValueError:
            continue
        if t < now or t >= monthend_dt:
            continue
        if last_valid is None or t > last_valid:
            last_valid = t
        dstr = tstr[:10]
        if dstr not in seen:
            day_diff = (t.date() - issue_date).days + 1
            mmdd = f"{dstr[5:7]}-{dstr[8:10]}"
            seen[dstr] = len(day_buckets)
            day_buckets.append({
                "date": dstr,
                "mmdd": mmdd,
                "lead_day": max(1, day_diff),
                "indices": [],
            })
        day_buckets[seen[dstr]]["indices"].append(i)

    if not day_buckets:
        return [], 0

    forecast_days = (
        math.ceil((last_valid - now).total_seconds() / 86400.0) if last_valid else 0
    )

    # Step 1: raw daily totals per member × day (mm → inches).
    raw_daily: list[list[float]] = []
    for k in member_keys:
        series = hourly.get(k) or []
        per_day: list[float] = []
        for b in day_buckets:
            total_mm = 0.0
            for idx in b["indices"]:
                if idx >= len(series):
                    continue
                v = series[idx]
                if v is None:
                    continue
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                if fv > 0:
                    total_mm += fv
            per_day.append(total_mm / 25.4)
        raw_daily.append(per_day)

    # Step 2: deviation-preserving skill blend (matches route.ts).
    num_members = len(member_keys)
    ens_mean_per_day = [
        sum(raw_daily[m][d] for m in range(num_members)) / num_members
        for d in range(len(day_buckets))
    ]
    blended_center: list[float] = []
    for d, b in enumerate(day_buckets):
        w = get_skill_weight(skill, station_code, b["lead_day"])
        climo_mean = climo_daily.get(b["mmdd"], 0.0)
        blended_center.append(w * ens_mean_per_day[d] + (1 - w) * climo_mean)

    member_sums: list[float] = []
    for m in range(num_members):
        total = 0.0
        for d in range(len(day_buckets)):
            dev = raw_daily[m][d] - ens_mean_per_day[d]
            total += max(0.0, blended_center[d] + dev)
        member_sums.append(round(total, 2))

    return member_sums, forecast_days


# --- Probability engine (mirrors src/lib/probability.ts) ---

def compute_probabilities(
    station_code: str,
    month: int,
    day_of_month: int,
    mtd: float,
    member_sums: list[float],
    forecast_days: int,
    hist: dict,
    enso_phase: str | None,
) -> dict[float, dict]:
    """Return {threshold: {"ensemble": p, "climatology": p}} for each threshold."""
    station_hist = hist["stations"].get(station_code) or {}
    month_data = (station_hist.get("months") or {}).get(str(month))

    dim = monthrange(2024, month)[1]  # April always 30 days
    if month_data:
        dim = month_data.get("days_in_month", dim)
    days_remaining = dim - day_of_month

    # Tail gamma for any uncovered days beyond the ensemble horizon.
    tail_gamma: dict | None = None
    if member_sums:
        uncovered = days_remaining - forecast_days
        if uncovered > 0:
            tail_start = day_of_month + forecast_days
            for d in range(tail_start, day_of_month, -1):
                dist = (month_data or {}).get("days", {}).get(str(d))
                cand = get_enso_gamma(dist, enso_phase)
                if cand:
                    tail_gamma = cand
                    break

    day_dist = (month_data or {}).get("days", {}).get(str(day_of_month))
    day_gamma = get_enso_gamma(day_dist, enso_phase)

    results: dict[float, dict] = {}
    for threshold in THRESHOLDS:
        remaining_needed = threshold - mtd
        if remaining_needed <= 0:
            results[threshold] = {"ensemble": 1.0, "climatology": 1.0}
            continue

        climo_prob = gamma_survival(remaining_needed, day_gamma) if day_gamma else 0.0

        ens_prob = climo_prob  # fallback if no members
        if member_sums:
            uncovered = days_remaining - forecast_days
            if uncovered <= 0:
                exceed = sum(1 for s in member_sums if s >= remaining_needed)
                ens_prob = exceed / len(member_sums)
            else:
                total = 0.0
                for s in member_sums:
                    gap = remaining_needed - s
                    if gap <= 0:
                        total += 1.0
                    elif tail_gamma:
                        total += gamma_survival(gap, tail_gamma)
                ens_prob = total / len(member_sums)

        results[threshold] = {
            "ensemble": round(ens_prob, 6),
            "climatology": round(climo_prob, 6),
        }

    return results


# --- Scoring ---

def brier_score(predictions: list[float], outcomes: list[int]) -> float:
    if not predictions:
        return float("nan")
    return float(np.mean([(p - o) ** 2 for p, o in zip(predictions, outcomes)]))


def reliability_bins(
    predictions: list[float],
    outcomes: list[int],
    n_bins: int = 10,
) -> list[dict]:
    """10 fixed deciles of predicted probability (0-0.1, 0.1-0.2, ...)."""
    bins: list[dict] = []
    for i in range(n_bins):
        lo = i / n_bins
        hi = (i + 1) / n_bins
        preds_in: list[float] = []
        outs_in: list[int] = []
        for p, o in zip(predictions, outcomes):
            # Top bin is inclusive on the right to catch P=1.0
            in_bin = (p >= lo and p < hi) or (i == n_bins - 1 and p == hi)
            if in_bin:
                preds_in.append(p)
                outs_in.append(o)
        if preds_in:
            bins.append({
                "bin_lo": round(lo, 2),
                "bin_hi": round(hi, 2),
                "count": len(preds_in),
                "mean_predicted": round(float(np.mean(preds_in)), 4),
                "observed_frequency": round(float(np.mean(outs_in)), 4),
            })
        else:
            bins.append({
                "bin_lo": round(lo, 2),
                "bin_hi": round(hi, 2),
                "count": 0,
                "mean_predicted": None,
                "observed_frequency": None,
            })
    return bins


# --- Main loop ---

def run_backtest() -> dict:
    print("Loading static data…")
    hist = load_historical()
    skill = load_skill_curves()
    enso_years = load_enso_years()
    climo_daily_all = build_daily_climo_mean(hist)

    # Per-station, per-(station,day,threshold) prediction records.
    # pred_rows[station][threshold] = list of {date, day, mtd, ens_prob, climo_prob, outcome}
    pred_rows: dict[str, dict[float, list[dict]]] = {
        s["code"]: {t: [] for t in THRESHOLDS} for s in STATIONS
    }

    for year, month in BACKTEST_MONTHS:
        dim = monthrange(year, month)[1]
        month_end = date(year + (1 if month == 12 else 0),
                         1 if month == 12 else month + 1, 1)
        enso_phase = enso_years.get(year)  # may be None

        print(f"\n=== Backtesting {year}-{month:02d} (ENSO: {enso_phase}) ===")

        for s in STATIONS:
            code = s["code"]
            station_climo = climo_daily_all.get(code, {})
            print(f"  [{code}] fetching IEM actuals…")
            try:
                daily = build_daily_precip(year, s["icao"])
            except (HTTPError, URLError, TimeoutError) as e:
                print(f"    [warn] IEM fetch failed for {code} {year}: {e}")
                continue

            actual_month_total = month_total(daily, year, month)
            print(f"    actual April total: {actual_month_total:.2f}\"")

            for day in range(1, dim + 1):
                issue = date(year, month, day)
                mtd = mtd_through(daily, year, month, day - 1)

                om = fetch_open_meteo_forecast(s, issue)
                if om is None:
                    continue

                member_sums, forecast_days = parse_ensemble(
                    om, issue, code, skill, station_climo, month_end,
                )
                probs = compute_probabilities(
                    code, month, day, mtd,
                    member_sums, forecast_days, hist, enso_phase,
                )

                for t in THRESHOLDS:
                    outcome = 1 if actual_month_total >= t else 0
                    pred_rows[code][t].append({
                        "date": issue.isoformat(),
                        "day": day,
                        "mtd": round(mtd, 3),
                        "ensemble_prob": probs[t]["ensemble"],
                        "climo_prob": probs[t]["climatology"],
                        "outcome": outcome,
                        "member_count": len(member_sums),
                        "forecast_days": forecast_days,
                    })

            print(f"    done: {sum(len(pred_rows[code][t]) for t in THRESHOLDS)} "
                  f"(station,day,threshold) predictions recorded")

    # --- Aggregate scoring ---

    print("\n=== Scoring ===")
    summary: dict = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "backtest_months": [f"{y}-{m:02d}" for y, m in BACKTEST_MONTHS],
        "thresholds": THRESHOLDS,
        "per_station": {},
        "overall": {},
    }

    all_ens_preds: list[float] = []
    all_climo_preds: list[float] = []
    all_outcomes: list[int] = []

    for s in STATIONS:
        code = s["code"]
        station_ens: list[float] = []
        station_climo: list[float] = []
        station_out: list[int] = []
        per_threshold: dict[str, dict] = {}

        for t in THRESHOLDS:
            rows = pred_rows[code][t]
            if not rows:
                per_threshold[f"{t:.1f}"] = {"count": 0}
                continue
            ens = [r["ensemble_prob"] for r in rows]
            cli = [r["climo_prob"] for r in rows]
            out = [r["outcome"] for r in rows]

            bs_ens = brier_score(ens, out)
            bs_cli = brier_score(cli, out)
            bss = 1 - (bs_ens / bs_cli) if bs_cli > 0 else float("nan")

            per_threshold[f"{t:.1f}"] = {
                "count": len(rows),
                "brier_ensemble": round(bs_ens, 6),
                "brier_climatology": round(bs_cli, 6),
                "brier_skill_score": None if math.isnan(bss) else round(bss, 6),
                "outcome_rate": round(sum(out) / len(out), 4),
                "reliability_bins": reliability_bins(ens, out),
            }

            station_ens += ens
            station_climo += cli
            station_out += out

        if station_ens:
            bs_ens = brier_score(station_ens, station_out)
            bs_cli = brier_score(station_climo, station_out)
            bss = 1 - (bs_ens / bs_cli) if bs_cli > 0 else float("nan")
            summary["per_station"][code] = {
                "city": s["city"],
                "n_predictions": len(station_ens),
                "brier_ensemble": round(bs_ens, 6),
                "brier_climatology": round(bs_cli, 6),
                "brier_skill_score": None if math.isnan(bss) else round(bss, 6),
                "reliability_bins": reliability_bins(station_ens, station_out),
                "per_threshold": per_threshold,
            }
            all_ens_preds += station_ens
            all_climo_preds += station_climo
            all_outcomes += station_out
        else:
            summary["per_station"][code] = {
                "city": s["city"],
                "n_predictions": 0,
                "per_threshold": per_threshold,
            }

    if all_ens_preds:
        bs_ens = brier_score(all_ens_preds, all_outcomes)
        bs_cli = brier_score(all_climo_preds, all_outcomes)
        bss = 1 - (bs_ens / bs_cli) if bs_cli > 0 else float("nan")
        summary["overall"] = {
            "n_predictions": len(all_ens_preds),
            "brier_ensemble": round(bs_ens, 6),
            "brier_climatology": round(bs_cli, 6),
            "brier_skill_score": None if math.isnan(bss) else round(bss, 6),
            "reliability_bins": reliability_bins(all_ens_preds, all_outcomes),
        }

    return summary


def print_summary_table(summary: dict) -> None:
    print("\n" + "=" * 78)
    print("BACKTEST SUMMARY — Ensemble vs. Climatology")
    print("Backtest months: " + ", ".join(summary["backtest_months"]))
    print("=" * 78)

    hdr = f"{'Station':<10}{'N':>6}{'Brier(ens)':>13}{'Brier(clim)':>14}{'BSS':>10}"
    print(hdr)
    print("-" * 78)
    for code, stats_row in summary["per_station"].items():
        n = stats_row.get("n_predictions", 0)
        if n == 0:
            print(f"{code:<10}{n:>6}{'—':>13}{'—':>14}{'—':>10}")
            continue
        be = stats_row["brier_ensemble"]
        bc = stats_row["brier_climatology"]
        bss = stats_row.get("brier_skill_score")
        bss_str = f"{bss:+.4f}" if bss is not None else "—"
        print(f"{code:<10}{n:>6}{be:>13.5f}{bc:>14.5f}{bss_str:>10}")
    print("-" * 78)

    overall = summary.get("overall") or {}
    if overall:
        n = overall["n_predictions"]
        be = overall["brier_ensemble"]
        bc = overall["brier_climatology"]
        bss = overall.get("brier_skill_score")
        bss_str = f"{bss:+.4f}" if bss is not None else "—"
        print(f"{'OVERALL':<10}{n:>6}{be:>13.5f}{bc:>14.5f}{bss_str:>10}")
    print("=" * 78)

    print("\nReliability (overall, ensemble) — mean predicted vs. observed frequency:")
    for b in (overall.get("reliability_bins") or []):
        if b["count"] == 0:
            print(f"  [{b['bin_lo']:.1f}, {b['bin_hi']:.1f}): (empty)")
            continue
        print(f"  [{b['bin_lo']:.1f}, {b['bin_hi']:.1f}):  "
              f"n={b['count']:<5}  mean_pred={b['mean_predicted']:.3f}  "
              f"observed={b['observed_frequency']:.3f}")
    print()


def main() -> int:
    os.makedirs(CACHE_DIR, exist_ok=True)
    summary = run_backtest()
    with open(OUT_PATH, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nWrote {OUT_PATH}")
    print_summary_table(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
