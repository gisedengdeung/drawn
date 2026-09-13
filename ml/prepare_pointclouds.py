"""Stage 2 — sample point clouds from the STL meshes into one training file.

The shipped pointCloud.npy is (100, 3), far too sparse for a 6-rotor airframe,
so points come from area-weighted sampling of cadfile.stl instead (stage 0
confirmed all 27,714 meshes load and are in millimetres).

Scale is the trap here. The usual PointNet recipe centres the cloud and divides
by its radius, which is right for classification and wrong for this task: a
30 cm airframe and a 5 m airframe would become the same input, and drone
performance is dominated by size. So the normalised cloud, the centroid and the
scale are all stored, and the scale is meant to be fed to the model as its own
scalar input. raw = points * scale + centroid recovers the millimetre geometry
exactly.

Mesh bounding-box extents are recorded at the same time. They cost nothing here
and they are rung 1 of the debugging ladder in docs/HANDOFF.md: a model that
cannot regress overall span from the cloud has a data-loading bug, not a
modelling problem.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\prepare_pointclouds.py
    ml\\.venv\\Scripts\\python.exe ml\\prepare_pointclouds.py --limit 200   # smoke test
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from common import REPO_ROOT, add_data_root_arg, iter_design_dirs, resolve_roots, write_json

DEFAULT_POINTS = 1024

# Sampling is random; this makes it reproducible per design.
SEED_SALT = 0x9E3779B1

# Stored alongside the geometry so the training file is self-contained.
# NaN marks "not trainable for this target" — see trainable() in prepare_targets.
TARGET_COLUMNS = (
    "Mass",
    "Max_Distance",
    "Hover_Time",
    "Max_Speed",
    "Power_MFD",
)
GEOMETRY_COLUMNS = (
    "fuselage_length",
    "fuselage_horz_diameter",
    "fuselage_vert_diameter",
    "arm_length_max",
    "arm_length_sum",
)
# Mass passes the >0 rule for every design but 11 report 60,000-240,000 kg.
MASS_GATED = {"Mass"}


def design_seed(design_id: int) -> int:
    return (design_id * SEED_SALT) % (2**32)


def sample_design(task):
    """Worker: load one STL, sample it, and return geometry as plain arrays."""
    design_id, design_dir, n_points = task
    import trimesh  # imported in the worker to keep process startup cheap

    try:
        mesh = trimesh.load_mesh(
            Path(design_dir) / "cadfile.stl", process=False, force="mesh"
        )
        if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
            return {"design_id": design_id, "error": "not a usable mesh"}

        points, _ = trimesh.sample.sample_surface(mesh, n_points, seed=design_seed(design_id))
        points = np.asarray(points, dtype=np.float64)

        centroid = points.mean(axis=0)
        centered = points - centroid
        scale = float(np.abs(centered).max())
        if not np.isfinite(scale) or scale <= 0:
            return {"design_id": design_id, "error": f"degenerate scale {scale}"}

        bounds = np.asarray(mesh.bounds, dtype=np.float64)
        return {
            "design_id": design_id,
            "points": (centered / scale).astype(np.float32),
            "centroid": centroid.astype(np.float32),
            "scale": np.float32(scale),
            "bbox_min": bounds[0].astype(np.float32),
            "bbox_max": bounds[1].astype(np.float32),
            "n_faces": np.int32(len(mesh.faces)),
            "n_vertices": np.int32(len(mesh.vertices)),
            "area": np.float32(mesh.area),
        }
    except Exception as exc:  # noqa: BLE001 - one bad mesh must not kill the run
        return {"design_id": design_id, "error": f"{type(exc).__name__}: {exc}"}


def load_stage1(path: Path) -> dict[int, dict]:
    if not path.is_file():
        raise SystemExit(
            f"ERROR: {path} not found.\n"
            "Run stage 1 first:  ml\\.venv\\Scripts\\python.exe ml\\prepare_targets.py"
        )
    with open(path, newline="", encoding="utf-8") as handle:
        return {int(row["design_id"]): row for row in csv.DictReader(handle)}


def to_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return np.nan
    return number if np.isfinite(number) else np.nan


def target_value(row: dict, column: str) -> float:
    """NaN unless the design is trainable for this target."""
    if not int(row.get(f"{column}_valid", 1) or 0):
        return np.nan
    if column in MASS_GATED and not int(row.get("mass_plausible", 1) or 0):
        return np.nan
    return to_float(row.get(column))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 2 point cloud sampling")
    add_data_root_arg(parser)
    parser.add_argument("--points", type=int, default=DEFAULT_POINTS)
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    parser.add_argument("--limit", type=int, default=None, help="smoke-test on N designs")
    parser.add_argument(
        "--targets", type=Path, default=REPO_ROOT / "ml" / "data" / "targets.csv"
    )
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "ml" / "data" / "pointclouds.npz")
    parser.add_argument(
        "--report", type=Path, default=REPO_ROOT / "ml" / "reports" / "stage2_report.json"
    )
    args = parser.parse_args(argv)

    roots = resolve_roots(args.data_root)
    stage1 = load_stage1(args.targets)

    tasks = []
    for root in roots:
        for design_id, design_dir in iter_design_dirs(root):
            tasks.append((design_id, str(design_dir), args.points))
    tasks.sort(key=lambda task: task[0])
    if args.limit:
        tasks = tasks[: args.limit]

    print("Stage 2 point cloud sampling")
    print(f"  designs : {len(tasks)}")
    print(f"  points  : {args.points}")
    print(f"  workers : {args.workers}")
    print(f"  output  : {args.out}")
    print()

    results: list[dict] = []
    failures: list[dict] = []
    started = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for done, result in enumerate(pool.map(sample_design, tasks, chunksize=32), start=1):
            if "error" in result:
                failures.append(result)
            else:
                results.append(result)
            if done % 2000 == 0:
                rate = done / (time.time() - started)
                remaining = (len(tasks) - done) / rate
                print(f"  ... {done}/{len(tasks)}  {rate:.0f}/s  eta {remaining / 60:.1f} min",
                      flush=True)

    elapsed = time.time() - started
    print(f"  sampled {len(results)} designs in {elapsed / 60:.1f} min "
          f"({len(tasks) / elapsed:.0f}/s), {len(failures)} failures")

    if not results:
        raise SystemExit("ERROR: nothing sampled")

    results.sort(key=lambda entry: entry["design_id"])
    design_ids = np.array([r["design_id"] for r in results], dtype=np.int32)

    points = np.stack([r["points"] for r in results]).astype(np.float32)
    centroid = np.stack([r["centroid"] for r in results]).astype(np.float32)
    scale = np.array([r["scale"] for r in results], dtype=np.float32)
    bbox_min = np.stack([r["bbox_min"] for r in results]).astype(np.float32)
    bbox_max = np.stack([r["bbox_max"] for r in results]).astype(np.float32)
    extents = (bbox_max - bbox_min).astype(np.float32)
    span = extents.max(axis=1).astype(np.float32)

    rows = [stage1[int(design_id)] for design_id in design_ids]
    splits = np.array([row["split"] for row in rows])
    families = np.array([row["family"] for row in rows])
    targets = np.array(
        [[target_value(row, column) for column in TARGET_COLUMNS] for row in rows],
        dtype=np.float32,
    )
    geometry = np.array(
        [[to_float(row.get(column)) for column in GEOMETRY_COLUMNS] for row in rows],
        dtype=np.float32,
    )
    n_propeller = np.array([int(row["n_propeller"]) for row in rows], dtype=np.int16)
    has_wing = np.array([int(row["has_wing"]) for row in rows], dtype=np.int8)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        args.out,
        design_id=design_ids,
        points=points,
        centroid=centroid,
        scale=scale,
        bbox_min=bbox_min,
        bbox_max=bbox_max,
        extents=extents,
        span=span,
        split=splits,
        family=families,
        targets=targets,
        target_names=np.array(TARGET_COLUMNS),
        geometry=geometry,
        geometry_names=np.array(GEOMETRY_COLUMNS),
        n_propeller=n_propeller,
        has_wing=has_wing,
        n_faces=np.array([r["n_faces"] for r in results], dtype=np.int32),
        area=np.array([r["area"] for r in results], dtype=np.float32),
    )

    # ---- self-checks ----------------------------------------------------
    # Denormalising must land back inside the mesh bounding box.
    raw = points * scale[:, None, None] + centroid[:, None, :]
    inside = (
        (raw >= bbox_min[:, None, :] - 1e-3) & (raw <= bbox_max[:, None, :] + 1e-3)
    ).all(axis=(1, 2))
    radius = np.linalg.norm(points, axis=2).max(axis=1)

    checks = {
        "all_designs_sampled": {
            "sampled": len(results),
            "expected": len(tasks),
            "pass": len(results) == len(tasks),
        },
        "points_finite": {"pass": bool(np.isfinite(points).all())},
        "denormalises_into_bbox": {
            "designs_outside": int((~inside).sum()),
            "pass": bool(inside.all()),
        },
        "normalised_within_unit_cube": {
            "max_abs": round(float(np.abs(points).max()), 6),
            "pass": bool(np.abs(points).max() <= 1.0 + 1e-5),
        },
        "scale_positive": {"pass": bool((scale > 0).all())},
        "split_matches_stage1": {
            "pass": bool(len(set(zip(families, splits))) == len(set(families)))
        },
    }
    all_passed = all(entry["pass"] for entry in checks.values())

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "stage2_passed": all_passed,
        "designs": len(results),
        "points_per_design": args.points,
        "elapsed_minutes": round(elapsed / 60, 2),
        "output": str(args.out),
        "output_mb": round(args.out.stat().st_size / 1024**2, 1),
        "failures": failures,
        "checks": checks,
        "normalisation": {
            "recipe": "centred on the sampled centroid, divided by max(|coord|)",
            "reconstruct": "raw_mm = points * scale + centroid",
            "why_scale_is_kept": "size dominates drone performance; unit-sphere "
                                 "normalisation alone would erase it",
            "unit": "mm",
        },
        "scale_mm": {
            "min": round(float(scale.min()), 2),
            "p50": round(float(np.percentile(scale, 50)), 2),
            "max": round(float(scale.max()), 2),
        },
        "span_mm": {
            "min": round(float(span.min()), 2),
            "p50": round(float(np.percentile(span, 50)), 2),
            "max": round(float(span.max()), 2),
        },
        "unit_sphere_radius": {
            "min": round(float(radius.min()), 4),
            "p50": round(float(np.percentile(radius, 50)), 4),
        },
        "split_sizes": {
            name: int((splits == name).sum()) for name in ("train", "val", "test")
        },
        "target_trainable": {
            name: int(np.isfinite(targets[:, index]).sum())
            for index, name in enumerate(TARGET_COLUMNS)
        },
    }
    write_json(args.report, report)

    print()
    print("=" * 70)
    for name, entry in checks.items():
        print(f"  [{'PASS' if entry['pass'] else 'FAIL'}] {name}")
    print()
    print(f"points array   : {points.shape} {points.dtype}")
    print(f"file size      : {report['output_mb']} MB")
    print(f"scale (mm)     : min {report['scale_mm']['min']}  "
          f"p50 {report['scale_mm']['p50']}  max {report['scale_mm']['max']}")
    print(f"span (mm)      : min {report['span_mm']['min']}  "
          f"p50 {report['span_mm']['p50']}  max {report['span_mm']['max']}")
    print(f"split          : {report['split_sizes']}")
    print(f"trainable      : {report['target_trainable']}")
    if failures:
        print(f"failures       : {len(failures)} (see report)")
    print("=" * 70)
    print(f"STAGE 2: {'PASSED' if all_passed else 'FAILED'}")
    print(f"report -> {args.report}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
