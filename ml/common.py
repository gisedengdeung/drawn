"""Shared helpers for the AircraftVerse ML pipeline.

Anything two or more stage scripts need lives here so the validity rule and the
trims.npy column order have exactly one definition.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent

DESIGN_DIR_RE = re.compile(r"^design_(\d+)$")

REQUIRED_FILES = (
    "cadfile.stl",
    "output.json",
    "design_low_level.json",
    "pointCloud.npy",
    "trims.npy",
)

POINTCLOUD_SCHEMA = ("<f4", (100, 3))
TRIMS_SCHEMA = ("<f8", (51, 12))

# trims.npy carries no column names. This order comes from
# scripts/prepare-aircraftverse.mjs:33-46 and was confirmed against design
# 17297 by ml/verify_stage0.py (check D). Row index is speed in m/s, 0-50.
TRIM_FIELDS = (
    "distance",
    "flightTime",
    "pitch",
    "maxUc",
    "thrust",
    "lift",
    "drag",
    "current",
    "power",
    "motorCurrentRatio",
    "motorPowerRatio",
    "batteryCurrentRatio",
)

# The 16 keys in output.json, confirmed identical across all 27,714 designs.
OUTPUT_KEYS = (
    "Mass",
    "Max_Distance",
    "Hover_Time",
    "Max_Speed",
    "Power_MFD",
    "Speed_MFD",
    "Distance_MxSpd",
    "Power_MxSpd",
    "Interferences",
    "Max_uc_at_MFD",
    "Mot_amps_ratio_MFD",
    "Mot_amps_ratio_MxSpd",
    "Mot_power_ratio_MFD",
    "Mot_power_ratio_MxSpd",
    "Batt_amps_ratio_MFD",
    "Batt_amps_ratio_MxSpd",
)


def is_available_metric(value) -> bool:
    """Mirrors isAvailableMetric in lib/aerotwin-types.ts:319.

    A KPI of 0 is a failed or infeasible analysis, not a physical zero.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value > 0


def trim_row_valid(row) -> bool:
    """A trim row is real only if some column is finite and non-zero.

    Same rule as createTrimRows in scripts/prepare-aircraftverse.mjs.
    """
    return bool(np.any(np.isfinite(row) & (row != 0)))


def read_npy_header(path: Path):
    """Return (dtype_str, shape, fortran_order) by parsing the header only."""
    with open(path, "rb") as handle:
        major, _minor = np.lib.format.read_magic(handle)
        if major == 1:
            shape, fortran, dtype = np.lib.format.read_array_header_1_0(handle)
        elif major == 2:
            shape, fortran, dtype = np.lib.format.read_array_header_2_0(handle)
        else:
            raise ValueError(f"unsupported NPY version {major}")
    return dtype.str, tuple(shape), fortran


def schema_matches(header, expected) -> bool:
    dtype_str, shape, fortran = header
    expected_dtype, expected_shape = expected
    return dtype_str == expected_dtype and shape == expected_shape and not fortran


def jsonable(value):
    """Last-resort coercion of numpy scalars/arrays for json.dumps."""
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, default=jsonable),
        encoding="utf-8",
    )


def iter_design_dirs(root: Path):
    """Yield (design_id, path) for every design_<N> directory under root."""
    with os.scandir(root) as entries:
        for entry in entries:
            if not entry.is_dir():
                continue
            match = DESIGN_DIR_RE.match(entry.name)
            if match:
                yield int(match.group(1)), Path(entry.path)


def default_roots() -> list[Path]:
    """AircraftVerse_1/2/3 as siblings of the repo, per docs/HANDOFF.md."""
    return [REPO_ROOT.parent / f"AircraftVerse_{n}" for n in (1, 2, 3)]


def add_data_root_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--data-root",
        action="append",
        type=Path,
        default=None,
        help="AircraftVerse_* directory; repeat once per part",
    )


def resolve_roots(roots: list[Path] | None) -> list[Path]:
    """Return existing data roots, or raise with an actionable message."""
    roots = roots or default_roots()
    missing = [str(r) for r in roots if not r.is_dir()]
    if missing:
        raise SystemExit(
            "ERROR: data root(s) not found:\n  "
            + "\n  ".join(missing)
            + "\n\nPass --data-root <path> once per AircraftVerse part."
        )
    return roots
