#!/usr/bin/env python3
"""
Score the GEFSv12 reforecast extractions against actuals.

For every April day from 2000 through 2019, for each of the 10 stations:
  - Load the cached reforecast extraction from
    scripts/.reforecast-cache/{station}/{YYYY-MM-DD}.json
    (5 ensemble members × 10 daily precip values in inches).
  - Compute MTD through the prior day from the GHCND cache in
    scripts/.ghcnd-cache/ (the same raw data used to build
    historical-distributions.json).
  - Run the same probability engine as the live system: a
    skill-weighted, deviation-preserving blend of the 5 members with
    the MTD-conditional gamma regression pulled from
    public/data/historical-distributions.json, then aggregate member
    sums into P(exceed threshold).
  - Record binary outcomes: did the actual April total exceed each of
    the 1..7-inch thresholds?

Produces Brier score per station, Brier skill score vs. the
climatological baseline, and a 10-bin reliability diagram, writing
everything to public/data/reforecast-results.json and printing a
station-by-station summary table.

This is a standalone script — all helpers are duplicated from
backtest-ensemble.py on purpose so the reforecast verification stays
independent of live-backtest plumbing.
"""

import gzip
import json
import math
import os
import sys
from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, timedelta

import numpy as np
from scipy import stats


# --- Paths ------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
PUBLIC_DATA = os.path.join(REPO_ROOT, "public", "data")

REFORECAST_CACHE = os.path.join(SCRIPT_DIR, ".reforecast-cache")
GHCND_CACHE = os.path.join(SCRIPT_DIR, ".ghcnd-cache")

HIST_PATH = os.path.join(PUBLIC_DATA, "historical-distributions.json")
SKILL_PATH = os.path.join(PUBLIC_DATA, "skill-curves.json")
ENSO_PATH = os.path.join(PUBLIC_DATA, "enso-years.json")
OUT_PATH = os.path.join(PUBLIC_DATA, "reforecast-results.json")


# --- Station config ---------------------------------------------------------

STATIONS = [
    {"code": "SFO", "city": "San Francisco",    "ghcnd": "USW00023234"},
    {"code": "LAX", "city": "Los Angeles",       "ghcnd": "USW00023174"},
    {"code": "MIA", "city": "Miami",             "ghcnd": "USW00012839"},
    {"code": "DEN", "city": "Denver",            "ghcnd": "USW00023062"},
    {"code": "MDW", "city": "Chicago",           "ghcnd": "USC00111577"},
    {"code": "NYC", "city": "New York",          "ghcnd": "USW00094728"},
    {"code": "SEA", "city": "Seattle",           "ghcnd": "USW00024233"},
    {"code": "AUS", "city": "Austin",            "ghcnd": "USW00013904"},
    {"code": "DFW", "city": "Dallas-Fort Worth", "ghcnd": "USW00003927"},
    {"code": "HOU", "city": "Houston",           "ghcnd": "USW00012918"},
]

THRESHOLDS = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
YEARS = range(2000, 2020)
MONTH = 4  # April
DAYS_IN_APRIL = 30
REFORECAST_LEAD_DAYS = 10


# --- GHCND actuals ----------------------------------------------------------

def _ghcnd_path(station_id: str) -> str | None:
    dly = os.path.join(GHCND_CACHE, f"{station_id}.dly")
    if os.path.exists(dly) and os.path.getsize(dly) > 0:
        return dly
    csv = os.path.join(GHCND_CACHE, f"{station_id}.csv.gz")
    if os.path.exists(csv) and os.path.getsize(csv) > 0:
        return csv
    return None


def parse_ghcnd_csv_gz(path: str, year_filter: int | None = None) -> dict[str, float]:
    """Parse NOAA's per-station CSV.gz into {YYYY-MM-DD: inches}. Drops
    rows with non-blank QFLAG or VALUE == -9999."""
    out: dict[str, float] = {}
    with gzip.open(path, "rt") as f:
        for line in f:
            parts = line.rstrip("\n").split(",")
            if len(parts) < 7:
                continue
            _sid, date_str, element, value_str, _mflag, qflag, _sflag = parts[:7]
            if element != "PRCP":
                continue
            if qflag and qflag.strip() != "":
                continue
            if len(date_str) != 8:
                continue
            try:
                y = int(date_str[:4])
                val = int(value_str)
            except ValueError:
                continue
            if year_filter is not None and y != year_filter:
                continue
            if val == -9999:
                continue
            iso = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
            out[iso] = max(0.0, val / 254.0)
    return out


def parse_ghcnd_dly(path: str, year_filter: int | None = None) -> dict[str, float]:
    """Parse a GHCND .dly file into {YYYY-MM-DD: inches}."""
    days_in_month = {1:31, 2:29, 3:31, 4:30, 5:31, 6:30,
                     7:31, 8:31, 9:30, 10:31, 11:30, 12:31}
    out: dict[str, float] = {}
    with open(path, "r") as f:
        for line in f:
            if len(line) < 21:
                continue
            if line[17:21] != "PRCP":
                continue
            try:
                year = int(line[11:15])
                month = int(line[15:17])
            except ValueError:
                continue
            if year_filter is not None and year != year_filter:
                continue
            if month < 1 or month > 12:
                continue
            for day in range(1, 32):
                off = 21 + (day - 1) * 8
                if off + 8 > len(line):
                    break
                val_str = line[off:off + 5].strip()
                qflag = line[off + 6]
                if qflag != " ":
                    continue
                try:
                    val = int(val_str)
                except ValueError:
                    continue
                if val == -9999:
                    continue
                if day > days_in_month.get(month, 31):
                    continue
                iso = f"{year:04d}-{month:02d}-{day:02d}"
                out[iso] = max(0.0, val / 254.0)
    return out


_ghcnd_cache: dict[str, dict[str, float]] = {}


def load_ghcnd_daily(station_id: str) -> dict[str, float]:
    """Return {YYYY-MM-DD: inches} for all years in the cached file.
    Cached in-process so the big CSVs parse once."""
    if station_id in _ghcnd_cache:
        return _ghcnd_cache[station_id]
    path = _ghcnd_path(station_id)
    if path is None:
        _ghcnd_cache[station_id] = {}
        return _ghcnd_cache[station_id]
    if path.endswith(".csv.gz"):
        daily = parse_ghcnd_csv_gz(path)
    else:
        daily = parse_ghcnd_dly(path)
    _ghcnd_cache[station_id] = daily
    return daily


def mtd_through(daily: dict[str, float], year: int, month: int, through_day: int) -> float:
    if through_day <= 0:
        return 0.0
    total = 0.0
    for d in range(1, through_day + 1):
        total += daily.get(f"{year:04d}-{month:02d}-{d:02d}", 0.0)
    return total


def month_total(daily: dict[str, float], year: int, month: int) -> float:
    dim = monthrange(year, month)[1]
    return sum(daily.get(f"{year:04d}-{month:02d}-{d:02d}", 0.0) for d in range(1, dim + 1))


# --- Historical distributions / skill / ENSO --------------------------------

def load_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def build_daily_climo_mean(hist: dict) -> dict[str, dict[str, float]]:
    """Mirror loadClimoDailyMean() in fetch-rainfall/route.ts.

    climo[station]["MM-DD"] = max(0, days[d-1].mean - days[d].mean)
    where days[d].mean is the mean remaining-month precip from day d on.
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


def get_skill_weight(skill: dict, station_code: str, lead_day: int) -> float:
    """Accumulated-skill fitted weight for a 1-indexed lead day."""
    if not skill or station_code not in skill:
        return 1.0
    fitted = skill[station_code]["accumulated_skill"]["fitted"]
    idx = min(max(lead_day - 1, 0), len(fitted) - 1)
    return float(fitted[idx])


def get_enso_gamma(day_dist: dict | None, enso_phase: str | None) -> dict | None:
    """ENSO-conditional gamma with fallback to unconditional."""
    if not day_dist:
        return None
    if enso_phase is None:
        return day_dist.get("gamma")
    cond = day_dist.get(f"gamma_{enso_phase}")
    return cond if cond is not None else day_dist.get("gamma")


def _mtd_percentile(mtd: float, sorted_q: list[float]) -> float:
    """Empirical percentile of `mtd` in a sorted ascending array, using
    the average-rank rule. Matches mtdPercentile() in probability.ts and
    the (rank - 0.5)/n convention used when fitting the regression."""
    n = len(sorted_q)
    if n == 0:
        return 0.5
    # First index with value >= mtd (bisect_left), >= mtd is where it'd insert on the left.
    import bisect
    first_ge = bisect.bisect_left(sorted_q, mtd)
    first_gt = bisect.bisect_right(sorted_q, mtd)
    if first_ge == first_gt:
        avg_rank = first_ge + 0.5
    else:
        avg_rank = (first_ge + first_gt - 1) / 2 + 1
    pct = (avg_rank - 0.5) / n
    return max(0.005, min(0.995, pct))


def get_conditional_gamma(
    day_dist: dict | None, mtd: float, enso_phase: str | None
) -> dict | None:
    """Evaluate the MTD-conditional gamma regression at `mtd`. Falls
    back to the ENSO/unconditional gamma when the regression coefficients
    or mtd_quantiles array are absent (e.g. day 0, or too few years)."""
    if not day_dist:
        return None
    reg = day_dist.get("conditional_gamma_reg")
    quantiles = day_dist.get("mtd_quantiles")
    if not reg or not quantiles:
        return get_enso_gamma(day_dist, enso_phase)
    pctile = _mtd_percentile(mtd, quantiles)
    try:
        shape = math.exp(reg["a"] + reg["b"] * pctile)
        scale = math.exp(reg["c"] + reg["d"] * pctile)
    except (OverflowError, KeyError):
        return get_enso_gamma(day_dist, enso_phase)
    if not math.isfinite(shape) or not math.isfinite(scale) or shape <= 0 or scale <= 0:
        return get_enso_gamma(day_dist, enso_phase)
    return {
        "shape": shape,
        "scale": scale,
        "zero_fraction": reg.get("zero_fraction", 0.0),
    }


def gamma_survival(x: float, params: dict) -> float:
    """P(X > x) under a zero-inflated gamma, matching probability.ts."""
    zf = params.get("zero_fraction", 0.0)
    if x <= 0:
        return 1 - zf
    cdf = stats.gamma.cdf(x, params["shape"], scale=params["scale"])
    return (1 - zf) * (1 - cdf)


# --- Reforecast loading + skill blend ---------------------------------------

def load_reforecast(station_code: str, issue_date: date) -> dict | None:
    path = os.path.join(
        REFORECAST_CACHE, station_code, f"{issue_date.isoformat()}.json"
    )
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def blend_reforecast(
    refcast: dict,
    issue_date: date,
    station_code: str,
    skill: dict,
    climo_daily: dict[str, float],
    month_end: date,
) -> tuple[list[float], int]:
    """Apply the deviation-preserving skill blend to the reforecast's 5
    members for calendar days falling within the month. Returns
    (member_sums, forecast_days) where member_sums is one blended
    total-remaining-precip-in-month per member."""
    members = refcast.get("members") or []
    if not members:
        return [], 0

    num_members = len(members)
    lead_days = max((len(m) for m in members if m is not None), default=0)
    if lead_days == 0:
        return [], 0

    # In-month lead-day indices.
    day_info: list[dict] = []
    for d in range(lead_days):
        cal_date = issue_date + timedelta(days=d)
        if cal_date >= month_end:
            break
        day_info.append({
            "d": d,
            "lead_day": d + 1,  # 1-indexed into skill curves
            "mmdd": f"{cal_date.month:02d}-{cal_date.day:02d}",
        })
    if not day_info:
        return [], 0

    # Raw daily totals per member for in-month lead days. None → 0.
    raw_daily: list[list[float]] = []
    for m_list in members:
        if m_list is None:
            raw_daily.append([0.0] * len(day_info))
            continue
        per_day: list[float] = []
        for info in day_info:
            v = m_list[info["d"]] if info["d"] < len(m_list) else None
            per_day.append(float(v) if v is not None else 0.0)
        raw_daily.append(per_day)

    n_days = len(day_info)
    ens_mean = [
        sum(raw_daily[m][i] for m in range(num_members)) / num_members
        for i in range(n_days)
    ]
    blended_center: list[float] = []
    for i, info in enumerate(day_info):
        w = get_skill_weight(skill, station_code, info["lead_day"])
        climo_mean = climo_daily.get(info["mmdd"], 0.0)
        blended_center.append(w * ens_mean[i] + (1 - w) * climo_mean)

    member_sums: list[float] = []
    for m in range(num_members):
        total = 0.0
        for i in range(n_days):
            dev = raw_daily[m][i] - ens_mean[i]
            total += max(0.0, blended_center[i] + dev)
        member_sums.append(round(total, 4))

    return member_sums, n_days


# --- Probability engine -----------------------------------------------------

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
    """Return {threshold: {"ensemble": p, "climatology": p}} using the
    MTD-conditional climo gamma for the climatological baseline."""
    station_hist = hist["stations"].get(station_code) or {}
    month_data = (station_hist.get("months") or {}).get(str(month))

    dim = DAYS_IN_APRIL
    if month_data:
        dim = month_data.get("days_in_month", dim)
    days_remaining = dim - day_of_month

    # Tail gamma (unconditional / ENSO) for uncovered days beyond horizon.
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
    day_gamma = get_conditional_gamma(day_dist, mtd, enso_phase)

    results: dict[float, dict] = {}
    for threshold in THRESHOLDS:
        remaining_needed = threshold - mtd
        if remaining_needed <= 0:
            results[threshold] = {"ensemble": 1.0, "climatology": 1.0}
            continue

        climo_prob = gamma_survival(remaining_needed, day_gamma) if day_gamma else 0.0

        ens_prob = climo_prob  # fallback if no ensemble
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


# --- Scoring helpers --------------------------------------------------------

def brier_score(predictions: list[float], outcomes: list[int]) -> float:
    if not predictions:
        return float("nan")
    return float(np.mean([(p - o) ** 2 for p, o in zip(predictions, outcomes)]))


def reliability_bins(
    predictions: list[float], outcomes: list[int], n_bins: int = 10,
) -> list[dict]:
    """10 fixed deciles of predicted probability (0-0.1, 0.1-0.2, …)."""
    bins: list[dict] = []
    for i in range(n_bins):
        lo = i / n_bins
        hi = (i + 1) / n_bins
        preds_in: list[float] = []
        outs_in: list[int] = []
        for p, o in zip(predictions, outcomes):
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


# --- Main loop --------------------------------------------------------------

def run_scoring() -> dict:
    print("Loading static data…")
    hist = load_json(HIST_PATH)
    try:
        skill = load_json(SKILL_PATH)
    except (OSError, json.JSONDecodeError):
        skill = {}
        print(f"  [warn] no skill curves at {SKILL_PATH}; defaulting weight=1.0")
    try:
        enso_raw = load_json(ENSO_PATH)
        enso_years = {int(k): v for k, v in enso_raw.items()}
    except (OSError, json.JSONDecodeError):
        enso_years = {}
    climo_daily_all = build_daily_climo_mean(hist)

    # pred_rows[station][threshold] = list of {date, day, mtd, ensemble_prob, climo_prob, outcome, member_count}
    pred_rows: dict[str, dict[float, list[dict]]] = {
        s["code"]: {t: [] for t in THRESHOLDS} for s in STATIONS
    }
    coverage_stats: dict[str, dict[str, int]] = defaultdict(
        lambda: {"loaded": 0, "missing": 0, "no_actual": 0}
    )

    month_end = date(2000, 5, 1)  # will rebuild per year below
    for year in YEARS:
        month_end_yr = date(year, MONTH + 1, 1) if MONTH < 12 else date(year + 1, 1, 1)
        enso_phase = enso_years.get(year)
        print(f"\n=== April {year} (ENSO: {enso_phase}) ===")

        for s in STATIONS:
            code = s["code"]
            station_climo = climo_daily_all.get(code, {})

            # Actuals for this station-year
            daily = load_ghcnd_daily(s["ghcnd"])
            actual_month = month_total(daily, year, MONTH) if daily else 0.0
            has_actual = bool(daily) and any(
                f"{year:04d}-{MONTH:02d}-{d:02d}" in daily for d in range(1, 31)
            )
            if not has_actual:
                coverage_stats[code]["no_actual"] += 1
                continue

            for day in range(1, DAYS_IN_APRIL + 1):
                issue = date(year, MONTH, day)
                mtd = mtd_through(daily, year, MONTH, day - 1)

                refcast = load_reforecast(code, issue)
                if refcast is None:
                    coverage_stats[code]["missing"] += 1
                    continue
                coverage_stats[code]["loaded"] += 1

                member_sums, fd = blend_reforecast(
                    refcast, issue, code, skill, station_climo, month_end_yr,
                )
                probs = compute_probabilities(
                    code, MONTH, day, mtd, member_sums, fd, hist, enso_phase,
                )

                for t in THRESHOLDS:
                    outcome = 1 if actual_month >= t else 0
                    pred_rows[code][t].append({
                        "date": issue.isoformat(),
                        "day": day,
                        "mtd": round(mtd, 3),
                        "ensemble_prob": probs[t]["ensemble"],
                        "climo_prob": probs[t]["climatology"],
                        "outcome": outcome,
                        "member_count": len(member_sums),
                        "forecast_days": fd,
                    })

    # --- Aggregate scoring ---

    summary: dict = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "years": [y for y in YEARS],
        "month": MONTH,
        "thresholds": THRESHOLDS,
        "coverage": {k: dict(v) for k, v in coverage_stats.items()},
        "per_station": {},
        "overall": {},
    }

    all_ens: list[float] = []
    all_cli: list[float] = []
    all_out: list[int] = []

    for s in STATIONS:
        code = s["code"]
        s_ens: list[float] = []
        s_cli: list[float] = []
        s_out: list[int] = []
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
            s_ens += ens
            s_cli += cli
            s_out += out

        if s_ens:
            bs_ens = brier_score(s_ens, s_out)
            bs_cli = brier_score(s_cli, s_out)
            bss = 1 - (bs_ens / bs_cli) if bs_cli > 0 else float("nan")
            summary["per_station"][code] = {
                "city": s["city"],
                "n_predictions": len(s_ens),
                "brier_ensemble": round(bs_ens, 6),
                "brier_climatology": round(bs_cli, 6),
                "brier_skill_score": None if math.isnan(bss) else round(bss, 6),
                "reliability_bins": reliability_bins(s_ens, s_out),
                "per_threshold": per_threshold,
            }
            all_ens += s_ens
            all_cli += s_cli
            all_out += s_out
        else:
            summary["per_station"][code] = {
                "city": s["city"],
                "n_predictions": 0,
                "per_threshold": per_threshold,
            }

    if all_ens:
        bs_ens = brier_score(all_ens, all_out)
        bs_cli = brier_score(all_cli, all_out)
        bss = 1 - (bs_ens / bs_cli) if bs_cli > 0 else float("nan")
        summary["overall"] = {
            "n_predictions": len(all_ens),
            "brier_ensemble": round(bs_ens, 6),
            "brier_climatology": round(bs_cli, 6),
            "brier_skill_score": None if math.isnan(bss) else round(bss, 6),
            "reliability_bins": reliability_bins(all_ens, all_out),
        }

    return summary


def print_summary_table(summary: dict) -> None:
    print("\n" + "=" * 80)
    print("REFORECAST SCORING — Ensemble (skill-weighted) vs. Conditional Climatology")
    years = summary.get("years") or []
    if years:
        print(f"April {years[0]}–{years[-1]} ({len(years)} years)")
    print("=" * 80)

    hdr = f"{'Station':<10}{'N':>7}{'Brier(ens)':>14}{'Brier(clim)':>14}{'BSS':>10}"
    print(hdr)
    print("-" * 80)
    for code, row in summary["per_station"].items():
        n = row.get("n_predictions", 0)
        if n == 0:
            print(f"{code:<10}{n:>7}{'—':>14}{'—':>14}{'—':>10}")
            continue
        be = row["brier_ensemble"]
        bc = row["brier_climatology"]
        bss = row.get("brier_skill_score")
        bss_str = f"{bss:+.4f}" if bss is not None else "—"
        print(f"{code:<10}{n:>7}{be:>14.5f}{bc:>14.5f}{bss_str:>10}")
    print("-" * 80)

    overall = summary.get("overall") or {}
    if overall:
        n = overall["n_predictions"]
        be = overall["brier_ensemble"]
        bc = overall["brier_climatology"]
        bss = overall.get("brier_skill_score")
        bss_str = f"{bss:+.4f}" if bss is not None else "—"
        print(f"{'OVERALL':<10}{n:>7}{be:>14.5f}{bc:>14.5f}{bss_str:>10}")
    print("=" * 80)

    # Coverage notes
    cov = summary.get("coverage") or {}
    if cov:
        print("\nCoverage (reforecast extractions loaded / missing per station):")
        for code, c in cov.items():
            print(f"  {code}: loaded={c.get('loaded', 0)}  missing={c.get('missing', 0)}"
                  f"  years_without_actuals={c.get('no_actual', 0)}")

    print("\nReliability (overall, ensemble) — mean predicted vs. observed frequency:")
    for b in (overall.get("reliability_bins") or []):
        if b.get("count", 0) == 0:
            print(f"  [{b['bin_lo']:.1f}, {b['bin_hi']:.1f}): (empty)")
            continue
        print(f"  [{b['bin_lo']:.1f}, {b['bin_hi']:.1f}):  "
              f"n={b['count']:<5}  mean_pred={b['mean_predicted']:.3f}  "
              f"observed={b['observed_frequency']:.3f}")
    print()


def main() -> int:
    if not os.path.isdir(REFORECAST_CACHE):
        print(
            f"ERROR: reforecast cache not found at {REFORECAST_CACHE}. "
            f"Run scripts/extract-reforecast.py first to populate it.",
            file=sys.stderr,
        )
        return 1

    summary = run_scoring()
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nWrote {OUT_PATH}")
    print_summary_table(summary)

    if not summary.get("overall"):
        print(
            "\nWARNING: no predictions were scored. The reforecast cache may be "
            "empty for the requested years — re-run scripts/extract-reforecast.py.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
