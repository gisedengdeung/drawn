"""Predict Mass and Max_Distance from an STL file using pointnet-geometry-v1.onnx.

Sampling is the one convention the ONNX graph does not handle for you:
1,024 points, area-weighted over the surface, in millimetres, as
(1, 1024, 3) float32. Centring, scale normalisation, log standardisation and
output de-standardisation are all inside the graph.

    python ml/predict_stl.py public/models/design-17297.stl
    python ml/predict_stl.py public/models/*.stl --repeat 5

Sampling is random. Pass --seed to make one run reproducible, or let the script
derive the training seed automatically when the filename is design-<id>.stl.

Output is ASCII only so it prints on cp949 consoles.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = REPO_ROOT / "ml" / "runs" / "pointnet-geometry-v1.onnx"
DEFAULT_EVAL = REPO_ROOT / "ml" / "reports" / "stage4_evaluation.json"
DEFAULT_POINTS = 1024

# Same salt as ml/prepare_pointclouds.py, so --seed-from-id reproduces training.
SEED_SALT = 0x9E3779B1

SHRINK_CEILING_M = 19824.0


def design_seed(design_id: int) -> int:
    return (design_id * SEED_SALT) % (2**32)


def design_id_from_name(path: Path) -> int | None:
    stem = path.stem
    if stem.startswith("design-") and stem[7:].isdigit():
        return int(stem[7:])
    return None


def sample_points_mm(mesh, n_points: int, seed: int | None) -> np.ndarray:
    """Area-weighted surface sampling. This is what teammates must reimplement."""
    import trimesh

    points, _ = trimesh.sample.sample_surface(mesh, n_points, seed=seed)
    return np.asarray(points, dtype=np.float32)


def load_bands(path: Path):
    if not path.is_file():
        return {}
    report = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for target, block in report.get("targets", {}).items():
        band = block.get("prediction_interval", {}).get("bands", {}).get("0.90")
        if band:
            out[target] = (band["low_multiplier"], band["high_multiplier"])
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stl", nargs="+", type=Path)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--points", type=int, default=DEFAULT_POINTS)
    parser.add_argument("--seed", type=int, default=None,
                        help="fixed sampling seed; default derives it from design-<id>.stl")
    parser.add_argument("--random", action="store_true",
                        help="ignore the derived seed and sample freshly each run")
    parser.add_argument("--repeat", type=int, default=1,
                        help="sample N times to show how much the sampling alone moves the answer")
    parser.add_argument("--eval-report", type=Path, default=DEFAULT_EVAL)
    args = parser.parse_args(argv)

    try:
        import onnxruntime
        import trimesh  # noqa: F401
    except ImportError as exc:
        print(f"missing dependency: {exc.name}")
        print("  pip install numpy onnxruntime trimesh")
        return 2

    if not args.model.is_file():
        print(f"model not found: {args.model}")
        print("  put pointnet-geometry-v1.onnx in ml/runs/ (it is gitignored)")
        return 2

    session = onnxruntime.InferenceSession(
        str(args.model), providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    bands = load_bands(args.eval_report)

    import trimesh

    print(f"model  : {args.model.name}")
    print(f"points : {args.points}  (area-weighted, millimetres)")
    print()

    for stl_path in args.stl:
        if not stl_path.is_file():
            print(f"  [SKIP] {stl_path}  not found")
            continue

        mesh = trimesh.load_mesh(stl_path, process=False, force="mesh")
        if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
            print(f"  [SKIP] {stl_path.name}  not a usable mesh")
            continue

        did = design_id_from_name(stl_path)
        if args.random:
            seed = None
            seed_note = "random"
        elif args.seed is not None:
            seed = args.seed
            seed_note = f"seed {args.seed}"
        elif did is not None:
            seed = design_seed(did)
            seed_note = f"training seed for design {did}"
        else:
            seed = None
            seed_note = "random"

        extents = mesh.bounds[1] - mesh.bounds[0]
        print(f"{stl_path.name}")
        print(f"  mesh    {len(mesh.faces):,} faces   bbox "
              f"{extents[0]:.0f} x {extents[1]:.0f} x {extents[2]:.0f} mm")
        print(f"  sample  {seed_note}")

        runs = []
        for i in range(max(1, args.repeat)):
            run_seed = None if seed is None else seed + i
            pts = sample_points_mm(mesh, args.points, run_seed)
            batch = pts[None]  # (1, N, 3) float32
            mass, distance = session.run(None, {input_name: batch})[0][0]
            runs.append((float(mass), float(distance)))

        mass_vals = np.array([r[0] for r in runs])
        dist_vals = np.array([r[1] for r in runs])

        mass, distance = mass_vals[0], dist_vals[0]
        print(f"  Mass          {mass:8.3f} kg", end="")
        if "Mass" in bands:
            lo, hi = bands["Mass"]
            print(f"   90% {mass * lo:.2f} - {mass * hi:.2f} kg")
        else:
            print()

        print(f"  Max_Distance  {distance:8.1f} m ", end="")
        if "Max_Distance" in bands:
            lo, hi = bands["Max_Distance"]
            print(f"   90% {distance * lo:.0f} - {distance * hi:.0f} m")
        else:
            print()

        if args.repeat > 1:
            print(f"  spread over {args.repeat} samplings: "
                  f"Mass {mass_vals.min():.3f}-{mass_vals.max():.3f} kg "
                  f"(+-{100 * mass_vals.std() / mass_vals.mean():.2f}%), "
                  f"Max_Distance {dist_vals.min():.0f}-{dist_vals.max():.0f} m "
                  f"(+-{100 * dist_vals.std() / dist_vals.mean():.2f}%)")

        if distance > 0.9 * SHRINK_CEILING_M:
            print(f"  NOTE: near the model ceiling (~{SHRINK_CEILING_M:.0f} m). "
                  "True distance may be far higher.")
        print()

    print("Max_Distance is shrunk toward the mean and never exceeds ~19,800 m.")
    print("Do not use it to rank or search designs. See docs/POINTNET_MODEL.md section 6.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
