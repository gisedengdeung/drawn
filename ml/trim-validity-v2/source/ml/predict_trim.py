"""Predict a 0..50 m/s trim curve from an STL with split ONNX graphs.

Only numpy, trimesh and onnxruntime are needed. Inference uses CPU; training
uses the CUDA checkpoint separately. STL coordinates must be millimetres in
the original CAD axes. The encoder runs once per surface resample (five by
default), and the small head predicts all 51 speeds from that descriptor.

    python ml/predict_trim.py --stl public/models/design-17297.stl
    python ml/predict_trim.py --stl shape.stl --repeat 5 --seed 42 --out ml/runs/shape.json

Public curve values are null where the validity classifier rejects the speed
or mean estimates violate basic physical bounds. Unmasked estimates are
explicitly separated under diagnostics. Resampling spread is not a calibrated
prediction interval and does not quantify all model uncertainty.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from predict_stl import design_id_from_name, design_seed, sample_points_mm
from verify_onnx_trim import sha256, signature_matches

ROOT = Path(__file__).resolve().parent.parent
TARGETS = ["pitch", "drag", "thrust", "flightTime", "power", "current"]


def load_runtime(manifest_path: Path, evaluation_path: Path | None,
                 threshold_override: float | None, threads: int):
    import onnxruntime as ort

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1 or manifest.get("verification_passed") is not True:
        raise ValueError("A numerically verified version-1 export manifest is required")
    if manifest["target_order"] != TARGETS:
        raise ValueError("Unexpected trim target order")
    paths = {}
    for name in ("encoder", "head", "test_vectors"):
        metadata = manifest["files"][name]
        path = manifest_path.parent / metadata["path"]
        if not path.is_file() or path.stat().st_size != metadata["bytes"] or sha256(path) != metadata["sha256"]:
            raise ValueError(f"Artifact hash/size mismatch: {name}")
        paths[name] = path
    validity = manifest["validity"]
    if threshold_override is not None:
        threshold = float(threshold_override)
        threshold_info = {"threshold": threshold, "status": "user_override_uncalibrated",
                          "selected_on": None, "method": "explicit --threshold override"}
    else:
        if validity.get("status") != "calibrated_on_validation" or validity.get("selected_on") != "val":
            raise ValueError("A validation-calibrated threshold is required; use an explicit --threshold only for uncalibrated diagnostics")
        reference = validity["evaluation_report"]
        evaluation_path = evaluation_path or manifest_path.parent / reference["path"]
        if not evaluation_path.is_file() or sha256(evaluation_path) != reference["sha256"]:
            raise ValueError("Calibration evaluation report is missing or differs from its manifest hash")
        evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
        if evaluation.get("model_version", {}).get("checkpoint", {}).get("sha256") != manifest["source_checkpoint"]["sha256"]:
            raise ValueError("Calibration checkpoint SHA256 does not match this model")
        selected = evaluation.get("validity", {}).get("threshold_selection", {})
        if selected.get("selected_on") != "val" or selected.get("threshold") != validity["threshold"]:
            raise ValueError("Manifest threshold does not match the evaluation report")
        threshold = float(validity["threshold"])
        threshold_info = dict(validity)
    if not 0 < threshold < 1:
        raise ValueError("Validity threshold must be between 0 and 1")
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    encoder, head = [ort.InferenceSession(str(paths[name]), options,
                                        providers=["CPUExecutionProvider"])
                     for name in ("encoder", "head")]
    if not signature_matches(encoder, manifest["io"]["encoder"]) or not signature_matches(head, manifest["io"]["head"]):
        raise ValueError("Graph signatures do not match the manifest")
    return encoder, head, manifest, threshold_info


def physical_violations(values: np.ndarray) -> list[dict]:
    """Minimal necessary bounds, not an aerodynamic feasibility solver."""
    violations = []
    for index, target in enumerate(TARGETS):
        value = float(values[index])
        if not np.isfinite(value):
            violations.append({"target": target, "value": None, "rule": "finite"})
        elif target == "flightTime" and value <= 0:
            violations.append({"target": target, "value": value, "rule": "flightTime > 0 s"})
        elif target in ("drag", "thrust", "power", "current") and value < 0:
            violations.append({"target": target, "value": value, "rule": f"{target} >= 0"})
    return violations


def summarize(trim_runs: np.ndarray, valid_runs: np.ndarray, threshold: float) -> tuple[list, dict]:
    means, stds = trim_runs.mean(axis=0), trim_runs.std(axis=0)
    probabilities, probability_stds = valid_runs.mean(axis=0), valid_runs.std(axis=0)
    curve, violations, sample_violations = [], [], []
    for speed in range(51):
        failures = physical_violations(means[speed])
        for violation in failures:
            violations.append({"speed_m_s": speed, **violation})
        for repeat, predictions in enumerate(trim_runs):
            for violation in physical_violations(predictions[speed]):
                sample_violations.append({"repeat": repeat, "speed_m_s": speed, **violation})
        classifier_valid = bool(probabilities[speed] >= threshold)
        usable = classifier_valid and not failures
        estimates = {name: float(means[speed, i]) if usable else None for i, name in enumerate(TARGETS)}
        estimates["distance"] = float(speed * means[speed, 3]) if usable else None
        spread = {name: float(stds[speed, i]) if usable else None for i, name in enumerate(TARGETS)}
        spread["distance"] = float(speed * stds[speed, 3]) if usable else None
        curve.append({
            "speed_m_s": speed, "valid_probability_mean": float(probabilities[speed]),
            "valid_probability_std": float(probability_stds[speed]),
            "resample_valid_fraction": float(np.mean(valid_runs[:, speed] >= threshold)),
            "classifier_valid": classifier_valid, "physical_bounds_ok": not failures,
            "usable_prediction": usable, "estimates": estimates,
            "resampling_std": spread,
        })
    diagnostics = {
        "note": "Unfiltered estimates include classifier-invalid speeds and physically invalid predictions; do not present them as feasible trim states.",
        "target_order": TARGETS, "speed_m_s": list(range(51)),
        "raw_estimate_mean": means.tolist(), "raw_estimate_std": stds.tolist(),
        "raw_distance_mean": (np.arange(51) * means[:, 3]).tolist(),
        "raw_distance_std": (np.arange(51) * stds[:, 3]).tolist(),
        "mean_physical_bound_violations": violations,
        "individual_resample_physical_bound_violations": sample_violations,
    }
    return curve, diagnostics


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stl", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=ROOT / "ml/reports/trim_onnx_manifest.json")
    parser.add_argument("--evaluation", type=Path, default=None,
                        help="Optional relocated copy of the exact calibration report recorded by the manifest")
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--threshold", type=float, default=None,
                        help="Explicit uncalibrated threshold override; recorded as such in output")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--out", type=Path, default=None,
                        help="JSON or CSV path; both formats are written with the same basename")
    args = parser.parse_args(argv)
    if args.repeat < 1 or args.threads < 1:
        parser.error("repeat and threads must be positive")
    if args.seed is not None and not 0 <= args.seed < 2**32:
        parser.error("seed must be in [0, 2**32)")
    if args.threshold is not None and not 0 < args.threshold < 1:
        parser.error("threshold must be in (0, 1)")
    try:
        import trimesh
        encoder, head, manifest, threshold = load_runtime(args.manifest, args.evaluation,
                                                         args.threshold, args.threads)
        mesh = trimesh.load(args.stl, force="mesh")
        if not len(mesh.faces) or not np.isfinite(mesh.vertices).all() or not np.isfinite(mesh.area) or mesh.area <= 0:
            raise ValueError("STL must contain a finite, nonempty surface")
        did = design_id_from_name(args.stl)
        if did is None:
            parent = re.fullmatch(r"design_(\d+)", args.stl.parent.name)
            did = int(parent.group(1)) if parent else None
        seed = args.seed if args.seed is not None else design_seed(did) if did is not None else 42
        n_points = int(manifest["sampling"]["num_points"])
        speeds = np.arange(51, dtype=np.float32)[None]
        all_trim, all_valid, seeds = [], [], []
        for repeat in range(args.repeat):
            run_seed = (seed + repeat) % 2**32
            cloud = sample_points_mm(mesh, n_points, run_seed)[None]
            features = encoder.run(["design_features"], {"points_mm": cloud})[0]
            trim, valid = head.run(["trim", "valid"], {"design_features": features, "speed": speeds})
            if not np.isfinite(trim).all() or not np.isfinite(valid).all():
                raise ValueError("Model produced non-finite values; prediction output was not written")
            if np.any((valid < 0) | (valid > 1)):
                raise ValueError("Model validity output is not a probability")
            all_trim.append(trim[0].astype(np.float64))
            all_valid.append(valid[0].astype(np.float64))
            seeds.append(run_seed)
        curve, diagnostics = summarize(np.stack(all_trim), np.stack(all_valid), threshold["threshold"])
        output_path = args.out or ROOT / "ml/runs" / f"trim_prediction_{did if did is not None else args.stl.stem}.json"
        json_path, csv_path = output_path.with_suffix(".json"), output_path.with_suffix(".csv")
        json_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_stl": {"path": str(args.stl.resolve()), "sha256": sha256(args.stl)},
            "source_manifest": {"path": str(args.manifest.resolve()), "sha256": sha256(args.manifest)},
            "source_checkpoint_sha256": manifest["source_checkpoint"]["sha256"],
            "inference_provider": "CPUExecutionProvider", "design_id": did,
            "sampling": {"points": n_points, "repeats": args.repeat, "seeds": seeds,
                         "method": "area_weighted_STL_surface", "input_units": "mm"},
            "validity_threshold": threshold, "target_order": TARGETS,
            "units": dict(zip(TARGETS + ["distance"], manifest["target_units"] + ["m"])),
            "limitations": ["Sampling spread is not a calibrated prediction interval.",
                            "Validity is a learned classifier; passing basic bounds does not prove aerodynamic feasibility.",
                            "Geometry alone does not identify hidden motor, battery or propeller specifications."],
            "curve": curve, "diagnostics": diagnostics,
        }
        json_path.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        fieldnames = ["speed_m_s", "valid_probability_mean", "valid_probability_std", "resample_valid_fraction",
                      "classifier_valid", "physical_bounds_ok", "usable_prediction", *TARGETS, "distance",
                      *[f"{name}_resampling_std" for name in TARGETS + ["distance"]]]
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in curve:
                writer.writerow({**{key: row[key] for key in fieldnames if key in row},
                                 **row["estimates"],
                                 **{f"{key}_resampling_std": value for key, value in row["resampling_std"].items()}})
        print(f"STL: {args.stl.name}; points: {n_points}; resamples: {args.repeat}; CPU ONNX inference")
        print(f"Threshold: {threshold['threshold']} ({threshold['status']})")
        print(f"Usable predicted speeds: {sum(row['usable_prediction'] for row in curve)}/51")
        print(f"Mean physical-bound violations: {len(diagnostics['mean_physical_bound_violations'])}")
        print(f"JSON: {json_path}")
        print(f"CSV: {csv_path}")
        print("Invalid public predictions are empty; unfiltered estimates are in JSON diagnostics.")
        return 0
    except (ImportError, OSError, ValueError, KeyError) as exc:
        print(f"Prediction failed: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
