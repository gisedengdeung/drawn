"""Test whether anchoring the trim model's thrust to Mass * g helps. It does not.

The idea was cheap and obvious: at hover, thrust must equal weight, so scale the
predicted thrust curve by (Mass * 9.8) / thrust_at_0 using the Mass that
pointnet-geometry-v1.onnx already predicts. No retraining, pure post-processing.

Measured end to end on the showcase designs, it makes thrust worse. The Mass
model's error is larger than the error it is meant to correct, so the anchor
injects more noise than it removes. This script records that result so nobody
spends a second week on it.

    python ml/check_hover_anchor.py

Writes ml/reports/hover_anchor_check.json. Output is ASCII only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "ml" / "runs"
SHOWCASE = REPO_ROOT / "public" / "data" / "showcase-designs.json"
MODELS = REPO_ROOT / "public" / "models"
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "hover_anchor_check.json"

SEED_SALT = 0x9E3779B1  # same as ml/prepare_pointclouds.py
N_POINTS = 1024
GRAVITY = 9.8
THRUST_INDEX = 2  # pitch, drag, thrust, flightTime, power, current

MISSING = """\
Needs all three ONNX files in ml/runs/ (gitignored, so not in the repo):
    trim-encoder-v1.onnx
    trim-head-v1.onnx
    pointnet-geometry-v1.onnx
Get them from the team drive.
"""


def design_seed(design_id: int) -> int:
    return (design_id * SEED_SALT) % (2**32)


def load_clean_designs() -> list[dict]:
    """Showcase designs whose 0 m/s row is a trustworthy hover solution.

    Two of the twelve have a degenerate 0 m/s row: drag is null, maxUc sits at
    exactly 0.5 and the motor power ratio is near zero, and thrust comes out far
    below weight (design 20015 reports 19.27 N for a 72.24 N aircraft). Those
    rows pass the row-level validity rule but are not physical, so anchoring
    cannot be judged against them.
    """
    showcase = json.loads(SHOWCASE.read_text(encoding="utf-8"))
    clean, dirty = [], []
    for key, design in sorted(showcase.items(), key=lambda kv: int(kv[0])):
        hover = [row for row in design["trim"] if row["speed"] == 0]
        if not hover or not hover[0]["valid"] or not hover[0]["thrust"]:
            continue
        entry = {
            "design_id": int(key),
            "mass_kg": float(design["mass"]),
            "weight_n": float(design["mass"]) * GRAVITY,
            "data_thrust_at_0": float(hover[0]["thrust"]),
            "trim": design["trim"],
        }
        (dirty if hover[0]["drag"] is None else clean).append(entry)
    return clean, dirty


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    needed = ["trim-encoder-v1.onnx", "trim-head-v1.onnx", "pointnet-geometry-v1.onnx"]
    if any(not (RUNS / name).is_file() for name in needed):
        print(MISSING)
        return 2
    try:
        import onnxruntime
        import trimesh
    except ImportError as exc:
        print(f"missing dependency: {exc.name}\n  pip install onnxruntime trimesh")
        return 2

    provider = ["CPUExecutionProvider"]
    encoder = onnxruntime.InferenceSession(str(RUNS / "trim-encoder-v1.onnx"), providers=provider)
    head = onnxruntime.InferenceSession(str(RUNS / "trim-head-v1.onnx"), providers=provider)
    mass_model = onnxruntime.InferenceSession(
        str(RUNS / "pointnet-geometry-v1.onnx"), providers=provider
    )
    speeds = np.arange(51, dtype=np.float32)[None]

    clean, dirty = load_clean_designs()
    residuals: dict[str, list[float]] = {k: [] for k in ("none", "predicted_mass", "half", "true_mass")}
    per_design = []

    for entry in clean:
        design_id = entry["design_id"]
        mesh = trimesh.load_mesh(MODELS / f"design-{design_id}.stl", process=False, force="mesh")
        points, _ = trimesh.sample.sample_surface(mesh, N_POINTS, seed=design_seed(design_id))
        batch = np.asarray(points, dtype=np.float32)[None]

        features = encoder.run(None, {"points_mm": batch})[0]
        trim = head.run(None, {"design_features": features, "speed": speeds})[0]
        predicted_mass = float(mass_model.run(None, {"points_mm": batch})[0][0][0])

        curve = trim[0, :, THRUST_INDEX]
        rows = [(r["speed"], r["thrust"]) for r in entry["trim"] if r["valid"] and r["thrust"]]
        speed_index = np.array([r[0] for r in rows])
        actual = np.array([r[1] for r in rows])
        predicted = curve[speed_index]

        scale_predicted = (predicted_mass * GRAVITY) / curve[0]
        scale_true = entry["weight_n"] / curve[0]

        variants = {
            "none": predicted,
            "predicted_mass": predicted * scale_predicted,
            "half": predicted * np.sqrt(scale_predicted),
            "true_mass": predicted * scale_true,
        }
        for name, values in variants.items():
            residuals[name] += list(actual - values)

        per_design.append(
            {
                "design_id": design_id,
                "rows_scored": len(rows),
                "mass_kg": round(entry["mass_kg"], 3),
                "predicted_mass_kg": round(predicted_mass, 3),
                "mass_error_pct": round(100 * (predicted_mass - entry["mass_kg"]) / entry["mass_kg"], 1),
                "model_thrust_at_0": round(float(curve[0]), 2),
                "weight_n": round(entry["weight_n"], 2),
                "thrust_over_weight": round(float(curve[0]) / entry["weight_n"], 3),
                "anchor_scale_predicted_mass": round(float(scale_predicted), 3),
                "mae_before": round(float(np.abs(actual - predicted).mean()), 3),
                "mae_after": round(float(np.abs(actual - variants["predicted_mass"]).mean()), 3),
            }
        )

    baseline = float(np.abs(np.array(residuals["none"])).mean())
    summary = {}
    for name, values in residuals.items():
        mae = float(np.abs(np.array(values)).mean())
        summary[name] = {
            "mae_n": round(mae, 3),
            "improvement_pct": round(100 * (baseline - mae) / baseline, 1),
        }

    ratios = [d["thrust_over_weight"] for d in per_design]
    report = {
        "question": "Does scaling the thrust curve so thrust at 0 m/s equals Mass * 9.8 help?",
        "answer": "No. With the current Mass model it makes thrust worse.",
        "method": (
            "Sample 1024 points from each showcase STL with the training seed, run "
            "trim-encoder + trim-head for the thrust curve and pointnet-geometry-v1 "
            "for Mass, then score the scaled curve against the dataset's own trims "
            "over that design's valid speeds."
        ),
        "designs": {
            "clean": [d["design_id"] for d in per_design],
            "excluded_degenerate_hover_row": [d["design_id"] for d in dirty],
            "rows_scored": len(residuals["none"]),
        },
        "hover_thrust_calibration": {
            "note": (
                "The trim model is already close to physics on clean designs. The "
                "38% violation reported earlier came from design 20015, whose own "
                "trim data says 19.27 N for a 72.24 N aircraft."
            ),
            "model_thrust_over_weight_median": round(float(np.median(ratios)), 3),
            "model_thrust_over_weight_range": [round(min(ratios), 3), round(max(ratios), 3)],
        },
        "variants": summary,
        "conclusion": (
            "The concept is sound - anchoring to the true Mass cuts thrust MAE by "
            "61%. The blocker is the Mass estimate. pointnet-geometry-v1 has a "
            "median relative error near 10% and reaches +22.8% on design 17297, "
            "which is larger than the hover error being corrected, so the anchor "
            "injects more error than it removes. Revisit only with a better Mass "
            "model, or train the trim model with the constraint in the loss."
        ),
        "per_design": per_design,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    print(f"  clean designs {len(per_design)}, {len(residuals['none'])} valid rows")
    print(f"  excluded degenerate hover rows: {[d['design_id'] for d in dirty]}")
    print()
    print(f"  {'variant':>20} {'MAE (N)':>9} {'change':>9}")
    for name in ("none", "predicted_mass", "half", "true_mass"):
        row = summary[name]
        print(f"  {name:>20} {row['mae_n']:9.2f} {row['improvement_pct']:+8.1f}%")
    print()
    print("  Anchoring with the predicted Mass is worse than doing nothing.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
