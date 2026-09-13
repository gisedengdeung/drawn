"""Stage 0 verification for the AircraftVerse point-cloud regression work.

Walks every design under the AircraftVerse_* roots and answers the questions
that stage 1 and stage 2 depend on:

  A. Do all five per-design files exist, and do the .npy headers really say
     pointCloud=(100,3) <f4 and trims=(51,12) <f8?
  B. Are design ids globally unique across the three parts?  (split leakage)
  C. Does the `isAvailableMetric` rule reproduce the counts in docs/HANDOFF.md?
  D. Is the trims.npy column order in scripts/prepare-aircraftverse.mjs correct?
  E. Do the STL meshes load, and are they in millimetres or metres?

Writes ml/reports/stage0_report.json and prints a summary.

The corpus_dic file is an untrusted Python pickle; this script never touches it.
Geom.stp is never parsed.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\verify_stage0.py
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from common import (
    POINTCLOUD_SCHEMA,
    REPO_ROOT,
    REQUIRED_FILES,
    TRIM_FIELDS,
    TRIMS_SCHEMA,
    add_data_root_arg,
    is_available_metric,
    iter_design_dirs,
    read_npy_header,
    resolve_roots,
    schema_matches,
    trim_row_valid,
    write_json,
)

# ---------------------------------------------------------------------------
# Expectations. Sourced from docs/HANDOFF.md and the frontend; a mismatch here
# is a finding, not a crash.
# ---------------------------------------------------------------------------

# docs/HANDOFF.md "0을 학습시키지 마세요"
EXPECTED_VALID_COUNTS = {
    "Mass": 27714,
    "Max_Distance": 10737,
    "Hover_Time": 7789,
}
EXPECTED_TOTAL_DESIGNS = 27714

# docs/HANDOFF.md "참고 — 검증된 수치", design 17297
REFERENCE_DESIGN_ID = 17297
REFERENCE_MASS = 6.9967
REFERENCE_TRIM_CHECKS = {
    # speed -> (field, expected)
    0: ("thrust", 68.57),
    25: ("distance", 20344.0),
}
REFERENCE_DRAG = {5: 1.0, 10: 3.98, 15: 8.85, 20: 15.31, 25: 23.17}
REFERENCE_FIRST_INVALID_SPEED = 30


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------


def scan(roots: list[Path]):
    total = 0
    missing_files: list[dict] = []
    bad_pointcloud: list[dict] = []
    bad_trims: list[dict] = []
    unreadable_output: list[dict] = []

    id_to_parts: dict[int, list[str]] = defaultdict(list)
    key_union: set[str] = set()
    key_seen_counts: dict[str, int] = defaultdict(int)
    valid_counts: dict[str, int] = defaultdict(int)
    design_paths: dict[int, Path] = {}

    started = time.time()
    for root in roots:
        part = root.name
        for design_id, design_dir in iter_design_dirs(root):
            total += 1
            id_to_parts[design_id].append(part)
            design_paths.setdefault(design_id, design_dir)

            missing = [name for name in REQUIRED_FILES if not (design_dir / name).is_file()]
            if missing:
                missing_files.append({"part": part, "design": design_dir.name, "missing": missing})

            pc_path = design_dir / "pointCloud.npy"
            if pc_path.is_file():
                try:
                    header = read_npy_header(pc_path)
                    if not schema_matches(header, POINTCLOUD_SCHEMA):
                        bad_pointcloud.append(
                            {"part": part, "design": design_dir.name,
                             "dtype": header[0], "shape": list(header[1])}
                        )
                except Exception as exc:  # noqa: BLE001 - record and continue
                    bad_pointcloud.append(
                        {"part": part, "design": design_dir.name, "error": str(exc)}
                    )

            trims_path = design_dir / "trims.npy"
            if trims_path.is_file():
                try:
                    header = read_npy_header(trims_path)
                    if not schema_matches(header, TRIMS_SCHEMA):
                        bad_trims.append(
                            {"part": part, "design": design_dir.name,
                             "dtype": header[0], "shape": list(header[1])}
                        )
                except Exception as exc:  # noqa: BLE001
                    bad_trims.append({"part": part, "design": design_dir.name, "error": str(exc)})

            out_path = design_dir / "output.json"
            if out_path.is_file():
                try:
                    payload = json.loads(out_path.read_text(encoding="utf-8"))
                except Exception as exc:  # noqa: BLE001
                    unreadable_output.append(
                        {"part": part, "design": design_dir.name, "error": str(exc)}
                    )
                else:
                    key_union.update(payload.keys())
                    for key, value in payload.items():
                        key_seen_counts[key] += 1
                        if is_available_metric(value):
                            valid_counts[key] += 1

            if total % 5000 == 0:
                print(f"  ... {total} designs ({time.time() - started:.0f}s)", flush=True)

    duplicates = {
        str(design_id): parts for design_id, parts in id_to_parts.items() if len(parts) > 1
    }

    return {
        "total_designs": total,
        "elapsed_seconds": round(time.time() - started, 1),
        "missing_files": missing_files,
        "bad_pointcloud": bad_pointcloud,
        "bad_trims": bad_trims,
        "unreadable_output": unreadable_output,
        "output_keys": sorted(key_union),
        "key_seen_counts": dict(sorted(key_seen_counts.items())),
        "valid_counts": dict(sorted(valid_counts.items())),
        "duplicate_ids": duplicates,
        "_design_paths": design_paths,
    }


# ---------------------------------------------------------------------------
# Check D — trim column order, using the reference design
# ---------------------------------------------------------------------------


def check_reference_trims(design_dir: Path) -> dict:
    trims = np.load(design_dir / "trims.npy")
    output = json.loads((design_dir / "output.json").read_text(encoding="utf-8"))
    col = {name: index for index, name in enumerate(TRIM_FIELDS)}

    result: dict = {"design_dir": str(design_dir), "checks": [], "passed": True}

    def record(label, actual, expected, tolerance):
        actual = float(actual)
        ok = bool(abs(actual - expected) <= max(tolerance, abs(expected) * 0.01))
        result["checks"].append(
            {"check": label, "actual": round(actual, 4),
             "expected": expected, "pass": ok}
        )
        if not ok:
            result["passed"] = False

    mass = output.get("Mass")
    record("output.Mass", mass, REFERENCE_MASS, 0.001)
    record("hover thrust == mass * 9.8", trims[0, col["thrust"]], REFERENCE_MASS * 9.8, 0.05)

    for speed, (field, expected) in REFERENCE_TRIM_CHECKS.items():
        record(f"trim[{speed}].{field}", trims[speed, col[field]], expected, 1.0)

    for speed, expected in REFERENCE_DRAG.items():
        record(f"trim[{speed}].drag", trims[speed, col["drag"]], expected, 0.05)

    # distance == speed * flightTime, at the max-flight-distance speed
    speed = 25
    derived = speed * trims[speed, col["flightTime"]]
    record("trim[25].distance == 25 * flightTime", trims[speed, col["distance"]], float(derived), 1.0)

    valid_speeds = [s for s in range(trims.shape[0]) if trim_row_valid(trims[s])]
    first_invalid = next(
        (s for s in range(trims.shape[0]) if not trim_row_valid(trims[s])), None
    )
    result["valid_speed_count"] = len(valid_speeds)
    result["first_invalid_speed"] = first_invalid
    result["first_invalid_speed_expected"] = REFERENCE_FIRST_INVALID_SPEED
    if first_invalid != REFERENCE_FIRST_INVALID_SPEED:
        result["passed"] = False

    return result


# ---------------------------------------------------------------------------
# Check E — STL load, unit, and point-cloud provenance clue
# ---------------------------------------------------------------------------


def check_stl(design_dir: Path, sample_points: int = 1024) -> dict:
    import trimesh

    mesh = trimesh.load_mesh(design_dir / "cadfile.stl", process=False)
    extents = np.asarray(mesh.extents, dtype=float)
    points, _ = trimesh.sample.sample_surface(mesh, sample_points)

    largest = float(extents.max())
    if largest > 100:
        unit = "mm"
    elif largest > 0.1:
        unit = "m"
    else:
        unit = "unknown"

    provided = np.load(design_dir / "pointCloud.npy")
    provided_extents = provided.max(axis=0) - provided.min(axis=0)

    return {
        "design_dir": str(design_dir),
        "vertices": int(len(mesh.vertices)),
        "faces": int(len(mesh.faces)),
        "watertight": bool(mesh.is_watertight),
        "bounds_min": [round(v, 3) for v in np.asarray(mesh.bounds[0], dtype=float).tolist()],
        "bounds_max": [round(v, 3) for v in np.asarray(mesh.bounds[1], dtype=float).tolist()],
        "extents": [round(v, 3) for v in extents.tolist()],
        "largest_extent": round(largest, 3),
        "unit_guess": unit,
        "sampled_shape": list(points.shape),
        "provided_pointcloud": {
            "shape": list(provided.shape),
            "dtype": str(provided.dtype),
            "extents": [round(float(v), 3) for v in provided_extents.tolist()],
            "bounds_min": [round(float(v), 3) for v in provided.min(axis=0).tolist()],
            "bounds_max": [round(float(v), 3) for v in provided.max(axis=0).tolist()],
        },
    }


def check_stl_sample(design_paths: dict, count: int, seed: int = 0) -> dict:
    import trimesh

    rng = random.Random(seed)
    ids = rng.sample(sorted(design_paths.keys()), min(count, len(design_paths)))
    failures = []
    units = defaultdict(int)
    for design_id in ids:
        try:
            mesh = trimesh.load_mesh(design_paths[design_id] / "cadfile.stl", process=False)
            largest = float(np.asarray(mesh.extents, dtype=float).max())
            units["mm" if largest > 100 else "m" if largest > 0.1 else "unknown"] += 1
        except Exception as exc:  # noqa: BLE001
            failures.append({"design": f"design_{design_id}", "error": str(exc)})
    return {"sampled": len(ids), "failures": failures, "unit_histogram": dict(units)}


# ---------------------------------------------------------------------------
# CUDA
# ---------------------------------------------------------------------------


def check_cuda() -> dict:
    try:
        import torch
    except ImportError as exc:
        return {"available": False, "error": f"torch not installed: {exc}"}
    info = {
        "torch_version": torch.__version__,
        "cuda_build": torch.version.cuda,
        "available": bool(torch.cuda.is_available()),
    }
    if info["available"]:
        info["device_name"] = torch.cuda.get_device_name(0)
        info["total_memory_gb"] = round(
            torch.cuda.get_device_properties(0).total_memory / 1024**3, 2
        )
    return info


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 0 data verification")
    add_data_root_arg(parser)
    parser.add_argument(
        "--out", type=Path, default=REPO_ROOT / "ml" / "reports" / "stage0_report.json"
    )
    parser.add_argument("--stl-sample", type=int, default=20)
    args = parser.parse_args(argv)

    roots = resolve_roots(args.data_root)

    print("Stage 0 verification")
    for root in roots:
        print(f"  root: {root}")
    print()

    print("[A/B/C] scanning designs ...", flush=True)
    scan_result = scan(roots)
    design_paths = scan_result.pop("_design_paths")

    print("[D] checking trims.npy column order ...", flush=True)
    reference_dir = design_paths.get(REFERENCE_DESIGN_ID)
    if reference_dir is None:
        trim_result = {"passed": False, "error": f"design_{REFERENCE_DESIGN_ID} not found"}
    else:
        trim_result = check_reference_trims(reference_dir)

    print("[E] loading STL meshes ...", flush=True)
    stl_result = check_stl(reference_dir) if reference_dir else {"error": "reference design missing"}
    stl_sample_result = check_stl_sample(design_paths, args.stl_sample)

    print("[F] checking CUDA ...", flush=True)
    cuda_result = check_cuda()

    # ---- pass/fail ------------------------------------------------------
    valid_counts = scan_result["valid_counts"]
    target_counts = {
        name: {
            "actual": valid_counts.get(name, 0),
            "expected": expected,
            "pass": valid_counts.get(name, 0) == expected,
        }
        for name, expected in EXPECTED_VALID_COUNTS.items()
    }

    criteria = {
        "design_count": {
            "actual": scan_result["total_designs"],
            "expected": EXPECTED_TOTAL_DESIGNS,
            "pass": scan_result["total_designs"] == EXPECTED_TOTAL_DESIGNS,
        },
        "all_files_present": {
            "missing": len(scan_result["missing_files"]),
            "pass": not scan_result["missing_files"],
        },
        "pointcloud_schema": {
            "violations": len(scan_result["bad_pointcloud"]),
            "expected": "<f4 (100, 3)",
            "pass": not scan_result["bad_pointcloud"],
        },
        "trims_schema": {
            "violations": len(scan_result["bad_trims"]),
            "expected": "<f8 (51, 12)",
            "pass": not scan_result["bad_trims"],
        },
        "output_json_readable": {
            "failures": len(scan_result["unreadable_output"]),
            "pass": not scan_result["unreadable_output"],
        },
        "design_ids_globally_unique": {
            "duplicates": len(scan_result["duplicate_ids"]),
            "pass": not scan_result["duplicate_ids"],
        },
        "target_validity_counts": {
            **target_counts,
            "pass": all(entry["pass"] for entry in target_counts.values()),
        },
        "trim_column_order": {
            "pass": bool(trim_result.get("passed")),
            "fields": list(TRIM_FIELDS),
        },
        "stl_loadable": {
            "sample_failures": len(stl_sample_result["failures"]),
            "pass": not stl_sample_result["failures"],
        },
        "cuda_available": {
            **cuda_result,
            "pass": bool(cuda_result.get("available")),
        },
    }
    all_passed = all(entry["pass"] for entry in criteria.values())

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "roots": [str(r) for r in roots],
        "stage0_passed": all_passed,
        "criteria": criteria,
        "scan": scan_result,
        "reference_design": {"id": REFERENCE_DESIGN_ID, "trims": trim_result, "stl": stl_result},
        "stl_sample": stl_sample_result,
        "cuda": cuda_result,
    }

    write_json(args.out, report)

    # ---- summary --------------------------------------------------------
    print()
    print("=" * 66)
    print(f"designs scanned : {scan_result['total_designs']} "
          f"({scan_result['elapsed_seconds']}s)")
    print(f"output.json keys: {len(scan_result['output_keys'])}")
    print()
    for name, entry in criteria.items():
        mark = "PASS" if entry["pass"] else "FAIL"
        print(f"  [{mark}] {name}")
    print()
    print("target validity (rule: isfinite(v) and v > 0)")
    for name, entry in target_counts.items():
        pct = entry["actual"] / max(scan_result["total_designs"], 1) * 100
        print(f"  {name:<14} {entry['actual']:>6} / {scan_result['total_designs']} "
              f"({pct:4.1f}%)  expected {entry['expected']}")
    print()
    if isinstance(stl_result, dict) and "unit_guess" in stl_result:
        print(f"STL unit        : {stl_result['unit_guess']} "
              f"(largest extent {stl_result['largest_extent']})")
        print(f"STL extents     : {stl_result['extents']}")
        print(f"provided pc ext : {stl_result['provided_pointcloud']['extents']}")
    print(f"CUDA            : {cuda_result}")
    print("=" * 66)
    print(f"STAGE 0: {'PASSED' if all_passed else 'FAILED'}")
    print(f"report -> {args.out}")

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
