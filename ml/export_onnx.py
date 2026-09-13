"""Stage 5 — export a self-contained ONNX model.

A bare export of the network would be a trap. The trained module expects a
cloud already centred, divided by its own radius, and paired with a
standardised log(scale); it returns standardised targets. Hand a teammate that
graph with raw millimetre coordinates and it answers with plausible nonsense —
no error, just wrong numbers.

So the wrapper below folds the whole recipe into the graph: it takes points in
millimetres and returns kilograms and metres. The only convention a consumer
still has to match is how the points were sampled (area-weighted over the STL
surface, 1,024 of them).

The export is verified against PyTorch on real designs before it is written,
and a set of test vectors is emitted so that whoever receives the file can
check their own runtime rather than trust it.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\export_onnx.py
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from common import REPO_ROOT, write_json
from dataset import DEFAULT_DATA, load_bundle
from model import PointNetRegressor

# Designs used as test vectors. 17297 is the reference airframe used throughout
# the docs; the others add a wing and a different rotor count.
VECTOR_DESIGN_IDS = (17297, 20015, 13077)
COORD_DECIMALS = 3  # 1 micron; far below anything meaningful for a 1 m airframe


class DeployablePointNet(nn.Module):
    """Millimetre point cloud in, physical units out.

    Input   (batch, num_points, 3) float32, millimetres, same frame as the STL
    Output  (batch, num_targets) float32, kg and metres
    """

    def __init__(self, trained: PointNetRegressor, checkpoint: dict):
        super().__init__()
        self.net = trained
        self.register_buffer(
            "target_mean", torch.tensor(checkpoint["target_mean"], dtype=torch.float32)
        )
        self.register_buffer(
            "target_std", torch.tensor(checkpoint["target_std"], dtype=torch.float32)
        )
        self.register_buffer(
            "scale_log_mean",
            torch.tensor(float(checkpoint["scale_log_mean"]), dtype=torch.float32),
        )
        self.register_buffer(
            "scale_log_std",
            torch.tensor(float(checkpoint["scale_log_std"]), dtype=torch.float32),
        )

    def forward(self, points_mm: torch.Tensor) -> torch.Tensor:
        centroid = points_mm.mean(dim=1, keepdim=True)
        centered = points_mm - centroid
        scale = centered.abs().amax(dim=(1, 2), keepdim=False).clamp_min(1e-6)

        normalised = centered / scale.reshape(-1, 1, 1)
        scale_feature = (
            (torch.log(scale) - self.scale_log_mean) / self.scale_log_std
        ).reshape(-1, 1)

        standardised = self.net(normalised.transpose(1, 2), scale_feature)
        return standardised * self.target_std + self.target_mean


def build(checkpoint_path: Path) -> tuple[DeployablePointNet, dict]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    missing = [k for k in ("scale_log_mean", "scale_log_std") if k not in checkpoint]
    if missing:
        raise SystemExit(
            f"checkpoint is missing {missing}.\n"
            "It predates the fix that stores them. Re-run ml/train.py, or backfill "
            "from ml/dataset.py load_bundle(...).scale_log_mean / .scale_log_std."
        )
    trained = PointNetRegressor(
        n_targets=len(checkpoint["target_names"]),
        use_scale=checkpoint.get("use_scale", True),
        dropout=checkpoint.get("dropout", 0.3),
        pool=checkpoint.get("pool", "max"),
    )
    trained.load_state_dict(checkpoint["state_dict"])
    model = DeployablePointNet(trained, checkpoint).eval()
    return model, checkpoint


def raw_points_mm(data, index: int) -> np.ndarray:
    """Undo stage 2's normalisation to recover millimetre coordinates."""
    return data["points"][index] * data["scale"][index] + data["centroid"][index]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 5 ONNX export")
    parser.add_argument(
        "--checkpoint", type=Path, default=REPO_ROOT / "ml" / "runs" / "rung3_mass_distance.pt"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument(
        "--out", type=Path, default=REPO_ROOT / "ml" / "runs" / "pointnet-geometry-v1.onnx"
    )
    parser.add_argument(
        "--vectors", type=Path,
        default=REPO_ROOT / "ml" / "reports" / "onnx_test_vectors.json",
    )
    parser.add_argument(
        "--report", type=Path, default=REPO_ROOT / "ml" / "reports" / "onnx_export.json"
    )
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--tolerance", type=float, default=1e-3)
    args = parser.parse_args(argv)

    model, checkpoint = build(args.checkpoint)
    target_names = [str(n) for n in checkpoint["target_names"]]
    data = np.load(args.data, allow_pickle=False)

    print(f"checkpoint : {args.checkpoint.name}")
    print(f"targets    : {target_names}")
    print(f"input      : (batch, num_points, 3) float32, millimetres")
    print(f"output     : (batch, {len(target_names)}) float32, {', '.join(target_names)}")
    print()

    # ---- export ---------------------------------------------------------
    example = torch.from_numpy(raw_points_mm(data, 0)[None]).float()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (example,),
        str(args.out),
        input_names=["points_mm"],
        output_names=["predictions"],
        dynamic_axes={
            "points_mm": {0: "batch", 1: "num_points"},
            "predictions": {0: "batch"},
        },
        opset_version=args.opset,
        dynamo=False,
    )
    print(f"exported -> {args.out}  ({args.out.stat().st_size / 1024:.0f} KB)")

    # ---- verify against PyTorch on real designs -------------------------
    import onnxruntime

    session = onnxruntime.InferenceSession(str(args.out), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    sample = rng.choice(len(data["design_id"]), size=64, replace=False)
    batch = np.stack([raw_points_mm(data, int(i)) for i in sample]).astype(np.float32)

    with torch.no_grad():
        torch_out = model(torch.from_numpy(batch)).numpy()
    onnx_out = session.run(None, {"points_mm": batch})[0]

    absolute = np.abs(torch_out - onnx_out)
    relative = absolute / np.clip(np.abs(torch_out), 1e-9, None)
    parity_ok = bool(relative.max() <= args.tolerance)
    print(f"parity     : max abs diff {absolute.max():.6g}, "
          f"max rel diff {relative.max():.3g} over {len(sample)} designs "
          f"-> {'PASS' if parity_ok else 'FAIL'}")

    # A cloud has no meaningful point order; the pooling should not care.
    shuffled = batch.copy()
    for row in shuffled:
        rng.shuffle(row)
    permuted = session.run(None, {"points_mm": shuffled})[0]
    permutation_delta = float(
        (np.abs(permuted - onnx_out) / np.clip(np.abs(onnx_out), 1e-9, None)).max()
    )
    permutation_ok = permutation_delta <= args.tolerance
    print(f"permutation: max rel diff {permutation_delta:.3g} "
          f"-> {'PASS' if permutation_ok else 'FAIL'}")

    # ---- test vectors ---------------------------------------------------
    lookup = {int(d): i for i, d in enumerate(data["design_id"])}
    vectors = []
    for design_id in VECTOR_DESIGN_IDS:
        if design_id not in lookup:
            continue
        index = lookup[design_id]
        points = np.round(raw_points_mm(data, index), COORD_DECIMALS).astype(np.float32)
        expected = session.run(None, {"points_mm": points[None]})[0][0]
        actual = data["targets"][index]
        vectors.append({
            "design_id": design_id,
            "split": str(data["split"][index]),
            "n_propeller": int(data["n_propeller"][index]),
            "has_wing": int(data["has_wing"][index]),
            "points_mm": points.tolist(),
            "expected_output": {
                name: round(float(expected[i]), 4) for i, name in enumerate(target_names)
            },
            "ground_truth": {
                name: (None if not np.isfinite(actual[i]) else round(float(actual[i]), 4))
                for i, name in enumerate(target_names)
            },
        })
        print(f"vector     : design {design_id} -> "
              + "  ".join(f"{n} {vectors[-1]['expected_output'][n]}" for n in target_names))

    write_json(args.vectors, {
        "note": "Feed points_mm (1024, 3) to the model as a batch of one and compare "
                "against expected_output. Coordinates are rounded to "
                f"{COORD_DECIMALS} decimals so the check is exact. ground_truth is the "
                "dataset value, which the model is not expected to reproduce exactly.",
        "input_name": "points_mm",
        "output_name": "predictions",
        "target_order": target_names,
        "tolerance": args.tolerance,
        "vectors": vectors,
    })

    digest = hashlib.sha256(args.out.read_bytes()).hexdigest()[:32]
    report = {
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "model_name": args.out.stem,
        "onnx": {"path": str(args.out), "sha256": digest, "bytes": args.out.stat().st_size},
        "source_checkpoint": str(args.checkpoint),
        "opset": args.opset,
        "io": {
            "input": {"name": "points_mm", "shape": ["batch", "num_points", 3],
                      "dtype": "float32", "unit": "mm"},
            "output": {"name": "predictions", "shape": ["batch", len(target_names)],
                       "dtype": "float32", "targets": target_names,
                       "units": ["kg", "m"][: len(target_names)]},
        },
        "baked_in": {
            "centroid_centering": True,
            "scale_normalisation": True,
            "log_scale_standardisation": {
                "mean": float(checkpoint["scale_log_mean"]),
                "std": float(checkpoint["scale_log_std"]),
            },
            "target_destandardisation": {
                name: {"mean": float(checkpoint["target_mean"][i]),
                       "std": float(checkpoint["target_std"][i])}
                for i, name in enumerate(target_names)
            },
        },
        "not_baked_in": "sampling 1024 points area-weighted over the STL surface",
        "checks": {
            "torch_onnx_parity": {
                "designs": len(sample),
                "max_abs_diff": float(absolute.max()),
                "max_rel_diff": float(relative.max()),
                "tolerance": args.tolerance,
                "pass": parity_ok,
            },
            "point_order_invariance": {
                "max_rel_diff": permutation_delta,
                "pass": bool(permutation_ok),
            },
        },
        "test_vectors": str(args.vectors),
    }
    write_json(args.report, report)

    all_passed = parity_ok and permutation_ok
    print()
    print("=" * 70)
    print(f"onnx sha256 : {digest}")
    print(f"vectors     -> {args.vectors}")
    print(f"report      -> {args.report}")
    print(f"EXPORT: {'PASSED' if all_passed else 'FAILED'}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
