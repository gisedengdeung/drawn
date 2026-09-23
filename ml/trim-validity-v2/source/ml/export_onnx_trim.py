"""Export the speed-conditioned trim model as an encoder and a small head.

Both graphs run on CPU. The encoder accepts millimetre coordinates and embeds
centring, max-absolute scale normalisation and standardised log(scale). The
head accepts raw m/s and returns six physical targets plus validity probability.
No regression output is silently masked or clamped by the deployment wrapper.

    python ml/export_onnx_trim.py --checkpoint ml/runs/trim_pointnet.pt
    python ml/verify_onnx_trim.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch
from torch import nn

from common import REPO_ROOT, write_json

TARGET_NAMES = ["pitch", "drag", "thrust", "flightTime", "power", "current"]
TARGET_UNITS = ["deg", "N", "N", "s", "W", "A"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path, manifest: Path) -> dict:
    return {
        "path": Path(os.path.relpath(path.resolve(), manifest.parent.resolve())).as_posix(),
        "sha256": sha256(path),
        "bytes": path.stat().st_size,
    }


class TrimEncoder(nn.Module):
    def __init__(self, net: nn.Module, normalization: dict):
        super().__init__()
        self.net = net
        self.register_buffer("scale_log_mean", torch.as_tensor(
            normalization["scale_log_mean"], dtype=torch.float32))
        self.register_buffer("scale_log_std", torch.as_tensor(
            normalization["scale_log_std"], dtype=torch.float32))

    def forward(self, points_mm: torch.Tensor) -> torch.Tensor:
        centered = points_mm - points_mm.mean(dim=1, keepdim=True)
        scale = centered.abs().amax(dim=(1, 2)).clamp_min(1e-6)
        points = centered / scale[:, None, None]
        scale_feature = ((torch.log(scale) - self.scale_log_mean)
                         / self.scale_log_std)[:, None]
        return self.net.encode(points.transpose(1, 2), scale_feature)


class TrimHead(nn.Module):
    def __init__(self, net: nn.Module, normalization: dict):
        super().__init__()
        self.net = net
        self.register_buffer("target_mean", torch.as_tensor(
            normalization["target_mean"], dtype=torch.float32))
        self.register_buffer("target_std", torch.as_tensor(
            normalization["target_std"], dtype=torch.float32))
        self.target_transform = normalization.get("target_transform", "raw")

    def forward(self, design_features: torch.Tensor, speed: torch.Tensor):
        regression, logits = self.net.decode(design_features, speed)
        trim = regression.float() * self.target_std + self.target_mean
        if self.target_transform == "signed_log1p":
            # ONNX opset 17 has Exp/Sub but no Expm1 operator.
            trim = torch.sign(trim) * (torch.exp(torch.abs(trim)) - 1.0)
        return trim, torch.sigmoid(logits.float())


def build(checkpoint_path: Path) -> tuple[TrimEncoder, TrimHead, dict]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if list(checkpoint["target_names"]) != TARGET_NAMES:
        raise ValueError(f"Unsupported target order: {checkpoint['target_names']}")
    normalization = checkpoint["normalization"]
    for name in ("target_mean", "target_std"):
        values = torch.as_tensor(normalization[name])
        if values.shape != (6,) or not torch.isfinite(values).all():
            raise ValueError(f"Invalid checkpoint normalization: {name}")
    if not torch.all(torch.as_tensor(normalization["target_std"]) > 0):
        raise ValueError("Target standard deviations must be positive")
    if not np.isfinite(float(normalization["scale_log_mean"])):
        raise ValueError("Invalid scale_log_mean")
    if not np.isfinite(float(normalization["scale_log_std"])) or float(normalization["scale_log_std"]) <= 0:
        raise ValueError("scale_log_std must be finite and positive")
    if normalization.get("target_transform", "raw") not in ("raw", "signed_log1p"):
        raise ValueError("Unknown target transform")
    if checkpoint.get("model_kind") == "trim_validity_v2":
        from model_validity_v2 import TrimValidityV2
        net = TrimValidityV2(**checkpoint["model_config"]).eval()
    elif checkpoint.get("model_kind") == "trim_validity_dual":
        from model_validity_dual import TrimValidityDual
        net = TrimValidityDual(**checkpoint["model_config"]).eval()
    else:
        from model_trim import TrimPointNet
        net = TrimPointNet(**checkpoint["model_config"]).eval()
    net.load_state_dict(checkpoint["state_dict"], strict=True)
    return TrimEncoder(net, normalization).eval(), TrimHead(net, normalization).eval(), checkpoint


def threshold_metadata(evaluation: Path, checkpoint_path: Path, manifest: Path) -> dict:
    if not evaluation.is_file():
        return {
            "status": "pending_validation_calibration", "threshold": None,
            "selected_on": None,
            "note": "The valid output is a probability. No deployment threshold has been selected.",
        }
    report = json.loads(evaluation.read_text(encoding="utf-8"))
    source = report.get("model_version", {}).get("checkpoint", {})
    if source.get("sha256") != sha256(checkpoint_path):
        raise ValueError("Evaluation report checkpoint SHA256 does not match the exported checkpoint")
    selected = report.get("validity", {}).get("threshold_selection", {})
    threshold = selected.get("threshold")
    if selected.get("selected_on") != "val" or threshold is None or not 0 < float(threshold) < 1:
        raise ValueError("Evaluation must supply a validity threshold calibrated on val")
    return {
        **selected, "threshold": float(threshold), "status": "calibrated_on_validation",
        "evaluation_report": artifact(evaluation, manifest),
        "rule": "valid_probability >= threshold",
    }


def compare(actual: np.ndarray, expected: np.ndarray, rtol: float, atol: float) -> dict:
    finite = bool(np.isfinite(actual).all() and np.isfinite(expected).all())
    difference = np.abs(actual.astype(np.float64) - expected.astype(np.float64))
    allowed = atol + rtol * np.abs(expected)
    return {
        "pass": finite and bool(np.all(difference <= allowed)),
        "max_absolute_difference": float(difference.max()),
        "max_tolerance_ratio": float((difference / allowed).max()),
        "rtol": rtol, "atol": atol,
    }


def raw_points_mm(points: np.ndarray, scale: np.ndarray, centroid: np.ndarray,
                  indices: np.ndarray) -> np.ndarray:
    return np.asarray(points[indices] * scale[indices, None, None]
                      + centroid[indices, None, :], dtype=np.float32)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=REPO_ROOT / "ml/runs/trim_pointnet.pt")
    parser.add_argument("--points", type=Path, default=None,
                        help="Defaults to checkpoint data_paths.points, then ml/data/pointclouds.npz")
    parser.add_argument("--encoder", type=Path, default=REPO_ROOT / "ml/runs/trim-encoder-v1.onnx")
    parser.add_argument("--head", type=Path, default=REPO_ROOT / "ml/runs/trim-head-v1.onnx")
    parser.add_argument("--manifest", type=Path, default=REPO_ROOT / "ml/reports/trim_onnx_manifest.json")
    parser.add_argument("--vectors", type=Path, default=REPO_ROOT / "ml/reports/trim_onnx_test_vectors.json")
    parser.add_argument("--evaluation", type=Path, default=REPO_ROOT / "ml/reports/stage7_trim_evaluation.json")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--verify-designs", type=int, default=32)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--rtol", type=float, default=1e-3)
    parser.add_argument("--atol", type=float, default=1e-3)
    args = parser.parse_args(argv)
    if args.verify_designs < 1 or args.threads < 1 or args.rtol <= 0 or args.atol <= 0:
        parser.error("verify-designs, threads and tolerances must be positive")

    import onnx
    import onnxruntime as ort

    torch.set_num_threads(args.threads)
    encoder, head, checkpoint = build(args.checkpoint)
    validity = threshold_metadata(args.evaluation, args.checkpoint, args.manifest)
    if checkpoint.get("model_kind") in ("trim_validity_v2", "trim_validity_dual"):
        validity.update({
            "representation": "51 independently learned integer-speed grid logits",
            "speed_grid_mps": list(range(51)),
            "fractional_speed_policy": "Linearly interpolate neighboring grid logits, then apply sigmoid.",
            "continuous_interval_assumption": False,
            "fractional_validity_separately_supervised": False,
        })
    points_path = args.points or Path(checkpoint.get("data_paths", {}).get(
        "points", REPO_ROOT / "ml/data/pointclouds.npz"))
    if not points_path.is_absolute():
        points_path = REPO_ROOT / points_path
    with np.load(points_path, allow_pickle=False) as data:
        design_ids, points = data["design_id"], data["points"]
        scale, centroid = data["scale"].reshape(-1), data["centroid"]
    if not len(design_ids):
        raise ValueError("Point-cloud dataset is empty")
    rng = np.random.default_rng(42)
    sample = rng.choice(len(design_ids), min(args.verify_designs, len(design_ids)), replace=False)
    raw = raw_points_mm(points, scale, centroid, sample)
    if not np.isfinite(raw).all():
        raise ValueError("Verification point clouds contain non-finite values")
    example = torch.from_numpy(raw[:1])
    speed = torch.arange(51, dtype=torch.float32).reshape(1, -1)
    # The tracer requires ordinary tensors, even while exporting eval mode.
    with torch.no_grad():
        features = encoder(example)
    dimension = int(features.shape[1])
    for path in (args.encoder, args.head, args.manifest, args.vectors):
        path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        encoder, (example,), str(args.encoder), input_names=["points_mm"],
        output_names=["design_features"],
        dynamic_axes={"points_mm": {0: "batch", 1: "num_points"},
                      "design_features": {0: "batch"}},
        opset_version=args.opset, dynamo=False,
    )
    torch.onnx.export(
        head, (features, speed), str(args.head), input_names=["design_features", "speed"],
        output_names=["trim", "valid"],
        dynamic_axes={"design_features": {0: "batch"}, "speed": {0: "batch", 1: "speeds"},
                      "trim": {0: "batch", 1: "speeds"}, "valid": {0: "batch", 1: "speeds"}},
        opset_version=args.opset, dynamo=False,
    )
    for path in (args.encoder, args.head):
        onnx.checker.check_model(str(path), full_check=True)
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = args.threads
    sessions = [ort.InferenceSession(str(path), session_options,
                                    providers=["CPUExecutionProvider"])
                for path in (args.encoder, args.head)]
    checks = []
    # Testing chunks also exercises dynamic batch sizes without a large CPU allocation.
    for start in range(0, len(raw), 8):
        batch = raw[start:start + 8]
        with torch.inference_mode():
            expected_features = encoder(torch.from_numpy(batch))
        produced_features = sessions[0].run(["design_features"], {"points_mm": batch})[0]
        checks.append({"check": "encoder_parity", "start": start,
                       **compare(produced_features, expected_features.numpy(), args.rtol, args.atol)})
        shuffled = batch.copy()
        for cloud in shuffled:
            rng.shuffle(cloud)
        shuffled_features = sessions[0].run(["design_features"], {"points_mm": shuffled})[0]
        checks.append({"check": "point_permutation_features", "start": start,
                       **compare(shuffled_features, produced_features, args.rtol, args.atol)})
        for speeds in (np.array([13.0], dtype=np.float32),
                       np.array([0.0, 0.5, 13.25, 49.75, 50.0], dtype=np.float32),
                       np.arange(51, dtype=np.float32)):
            speed_batch = np.repeat(speeds[None], len(batch), axis=0)
            with torch.inference_mode():
                expected = head(expected_features, torch.from_numpy(speed_batch))
            produced = sessions[1].run(["trim", "valid"],
                                      {"design_features": produced_features, "speed": speed_batch})
            permuted = sessions[1].run(["trim", "valid"],
                                      {"design_features": shuffled_features, "speed": speed_batch})
            for index, label in enumerate(("trim", "valid")):
                tolerance = args.atol if label == "trim" else 1e-5
                checks.append({"check": f"{label}_parity", "start": start,
                               "speed_count": len(speeds),
                               **compare(produced[index], expected[index].numpy(), args.rtol, tolerance)})
                checks.append({"check": f"point_permutation_{label}", "start": start,
                               "speed_count": len(speeds),
                               **compare(permuted[index], produced[index], args.rtol, tolerance)})
    passed = all(entry["pass"] for entry in checks)

    lookup = {int(d): i for i, d in enumerate(design_ids)}
    vector_ids = [did for did in (17297, 20015, 13077) if did in lookup]
    for did in design_ids[sample]:
        if len(vector_ids) >= 3:
            break
        if int(did) not in vector_ids:
            vector_ids.append(int(did))
    vectors = []
    for did in vector_ids:
        cloud = np.round(raw_points_mm(points, scale, centroid, np.array([lookup[did]])), 3)
        cloud = cloud.astype(np.float32)
        with torch.inference_mode():
            vector_features = encoder(torch.from_numpy(cloud))
            vector_trim, vector_valid = head(vector_features, speed)
        vectors.append({
            "design_id": did, "points_mm": cloud[0].tolist(),
            "speed": speed[0].tolist(), "expected_trim": vector_trim[0].tolist(),
            "expected_valid": vector_valid[0].tolist(),
        })
    write_json(args.vectors, {
        "schema_version": 1, "target_order": TARGET_NAMES,
        "expected_from": "PyTorch float32 CPU using the rounded points stored here",
        "tolerances": {"rtol": args.rtol, "trim_atol": args.atol, "valid_atol": 1e-5},
        "vectors": vectors,
    })
    manifest = {
        "schema_version": 1,
        "model_kind": checkpoint.get("model_kind", "speed_conditioned_trim_pointnet"),
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "verification_passed": passed,
        "files": {"encoder": artifact(args.encoder, args.manifest),
                  "head": artifact(args.head, args.manifest),
                  "test_vectors": artifact(args.vectors, args.manifest)},
        "source_checkpoint": artifact(args.checkpoint, args.manifest),
        "model_config": checkpoint["model_config"], "best_epoch": checkpoint.get("best_epoch"),
        "opset": args.opset,
        "versions": {"torch": str(torch.__version__), "onnx": onnx.__version__,
                     "onnxruntime": ort.__version__, "numpy": np.__version__},
        "target_order": TARGET_NAMES, "target_units": TARGET_UNITS,
        "io": {
            "encoder": {"inputs": {"points_mm": {"shape": ["batch", "num_points", 3],
                         "dtype": "float32", "units": "mm"}},
                        "outputs": {"design_features": {"shape": ["batch", dimension], "dtype": "float32"}}},
            "head": {"inputs": {"design_features": {"shape": ["batch", dimension], "dtype": "float32"},
                                "speed": {"shape": ["batch", "speeds"], "dtype": "float32", "units": "m/s", "range": [0, 50]}},
                     "outputs": {"trim": {"shape": ["batch", "speeds", 6], "dtype": "float32", "units": TARGET_UNITS},
                                 "valid": {"shape": ["batch", "speeds"], "dtype": "float32", "meaning": "sigmoid probability"}}},
        },
        "sampling": {"num_points": int(points.shape[1]), "method": "area_weighted_STL_surface",
                     "coordinates": "millimetres in the original AircraftVerse CAD frame; do not rotate axes"},
        "baked_in": ["centroid subtraction", "max absolute centered coordinate scale",
                     "standardized log scale", "speed / 50", "target inverse standardization",
                     "target inverse transform", "validity sigmoid"],
        "target_transform": checkpoint["normalization"].get("target_transform", "raw"),
        "normalization": {key: value.detach().cpu().tolist() if isinstance(value, torch.Tensor) else value
                          for key, value in checkpoint["normalization"].items()},
        "validity": validity,
        "derived_outputs": {"distance": {"formula": "speed * trim[..., 3]", "unit": "m"}},
        "excluded_outputs": ["lift"],
        "prediction_contract": "The six regression outputs are unmasked estimates. Consult valid probability and the calibrated threshold before presenting a speed as feasible.",
        "checks": {"designs": len(sample), "speed_lengths": [1, 5, 51],
                   "fractional_speed_vector_mps": [0.0, 0.5, 13.25, 49.75, 50.0],
                   "dynamic_batch_sizes": sorted({len(raw[i:i + 8]) for i in range(0, len(raw), 8)} | {1}),
                   "results": checks},
    }
    write_json(args.manifest, manifest)
    print(f"Encoder: {args.encoder} ({args.encoder.stat().st_size:,} bytes)")
    print(f"Head: {args.head} ({args.head.stat().st_size:,} bytes)")
    print(f"Manifest: {args.manifest}")
    print(f"Validity threshold: {validity['threshold']} ({validity['status']})")
    print(f"EXPORT {'PASSED' if passed else 'FAILED'}: {len(checks)} checks on {len(sample)} designs")
    for entry in checks:
        if not entry["pass"]:
            print(json.dumps(entry))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
