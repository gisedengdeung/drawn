"""Check that pointnet-geometry-v1.onnx runs correctly in your environment.

Run this after downloading the model from the team drive, before wiring it into
anything. The preprocessing is baked into the graph, but the *input convention*
is not: get the axis order or the unit wrong and the model answers with
plausible numbers rather than an error. That is what this script catches.

Only numpy and onnxruntime are needed — not PyTorch, not the training data.

    pip install numpy onnxruntime
    python ml/verify_onnx.py

Expected result is five PASS lines. Anything else is explained inline.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = REPO_ROOT / "ml" / "runs" / "pointnet-geometry-v1.onnx"
DEFAULT_VECTORS = REPO_ROOT / "ml" / "reports" / "onnx_test_vectors.json"
DEFAULT_EXPORT_REPORT = REPO_ROOT / "ml" / "reports" / "onnx_export.json"

MISSING_MODEL_HELP = """
The model file is not in the repository — ml/runs/ is gitignored, and a 5 MB
binary does not belong in git. Get pointnet-geometry-v1.onnx from the team
drive and put it at:

    {path}

Or re-export it yourself, if you have the training checkpoint:

    ml\\.venv\\Scripts\\python.exe ml\\export_onnx.py
"""


def check(label: str, passed: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if passed else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))
    return passed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Verify the exported ONNX model")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    parser.add_argument("--export-report", type=Path, default=DEFAULT_EXPORT_REPORT)
    parser.add_argument("--tolerance", type=float, default=1e-3,
                        help="max relative difference from the expected output")
    args = parser.parse_args(argv)

    if not args.model.is_file():
        print(MISSING_MODEL_HELP.format(path=args.model))
        return 2
    if not args.vectors.is_file():
        print(f"test vectors not found at {args.vectors} — pull the branch again.")
        return 2

    try:
        import onnxruntime
    except ImportError:
        print("onnxruntime is not installed:  pip install onnxruntime")
        return 2

    vectors = json.loads(args.vectors.read_text(encoding="utf-8"))
    target_order = vectors["target_order"]
    tolerance = args.tolerance

    print(f"model   : {args.model}  ({args.model.stat().st_size / 1024**2:.2f} MB)")
    print(f"vectors : {args.vectors.name}  ({len(vectors['vectors'])} designs)")
    print()

    results = []

    # 1 — the file survived the download ---------------------------------
    digest = hashlib.sha256(args.model.read_bytes()).hexdigest()[:32]
    expected_digest = None
    if args.export_report.is_file():
        expected_digest = json.loads(args.export_report.read_text(encoding="utf-8"))[
            "onnx"
        ]["sha256"]
    if expected_digest is None:
        print(f"  [SKIP] file hash            no export report to compare against")
    elif digest == expected_digest:
        results.append(check("file hash", True, digest))
    else:
        results.append(check("file hash", False, f"{digest} != {expected_digest}"))
        print("         The file differs from the one that was exported. Either it was")
        print("         re-exported (fine, and the checks below still decide), or the")
        print("         download was corrupted (re-download before reading further).")

    session = onnxruntime.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])

    # 2 — the interface is what the docs promise --------------------------
    model_input = session.get_inputs()[0]
    model_output = session.get_outputs()[0]
    signature_ok = (
        model_input.name == vectors["input_name"]
        and len(model_input.shape) == 3
        and model_input.shape[2] == 3
        and model_output.shape[1] == len(target_order)
    )
    results.append(check(
        "input/output signature", signature_ok,
        f"{model_input.name}{model_input.shape} -> {model_output.name}{model_output.shape}",
    ))
    print(f"         input is millimetres, axis order (batch, num_points, 3)")
    print(f"         output order is {target_order}")
    print()

    # 3 — the numbers match ----------------------------------------------
    print("  test vectors")
    vector_ok = True
    first_points = None
    first_expected = None
    for entry in vectors["vectors"]:
        points = np.asarray(entry["points_mm"], dtype=np.float32)[None]
        if first_points is None:
            first_points = points
        produced = session.run(None, {vectors["input_name"]: points})[0][0]
        expected = np.array([entry["expected_output"][n] for n in target_order])
        if first_expected is None:
            first_expected = produced.copy()

        relative = np.abs(produced - expected) / np.clip(np.abs(expected), 1e-9, None)
        ok = bool(relative.max() <= tolerance)
        vector_ok &= ok
        values = "  ".join(
            f"{n} {produced[i]:.4f} (expected {expected[i]:.4f})"
            for i, n in enumerate(target_order)
        )
        print(f"    [{'PASS' if ok else 'FAIL'}] design {entry['design_id']:<6} {values}")
    results.append(vector_ok)
    print()

    # 4 — a cloud has no point order --------------------------------------
    shuffled = first_points.copy()
    np.random.default_rng(0).shuffle(shuffled[0])
    permuted = session.run(None, {vectors["input_name"]: shuffled})[0][0]
    permutation_delta = float(
        (np.abs(permuted - first_expected) / np.clip(np.abs(first_expected), 1e-9, None)).max()
    )
    results.append(check(
        "point order does not matter", permutation_delta <= tolerance,
        f"max rel diff {permutation_delta:.2g}",
    ))

    # 5 — the failure this script exists for ------------------------------
    # Axes swapped: 3 "points" of 1024 coordinates. Shape-legal, meaningless.
    swapped = np.ascontiguousarray(first_points.transpose(0, 2, 1)[:, :, :3])
    try:
        wrong = session.run(None, {vectors["input_name"]: swapped})[0][0]
        differs = bool(
            (np.abs(wrong - first_expected) / np.clip(np.abs(first_expected), 1e-9, None)).max()
            > tolerance
        )
        results.append(check(
            "wrong axis order is detectable", differs,
            "  ".join(f"{n} {wrong[i]:.1f}" for i, n in enumerate(target_order)),
        ))
        print("         Those are the numbers you get from (batch, 3, num_points).")
        print("         No exception, just wrong answers — which is why you pass")
        print("         (batch, num_points, 3) and why this script exists.")
    except Exception:
        results.append(check("wrong axis order is detectable", True, "rejected outright"))

    # ---- verdict --------------------------------------------------------
    passed = all(results)
    print()
    print("=" * 70)
    if passed:
        print("VERIFIED — the model runs correctly here.")
        print()
        print("Next: sample 1,024 points area-weighted over the STL surface, in")
        print("millimetres, and feed them as (1, 1024, 3) float32. That sampling is")
        print("the one convention the graph does not handle for you.")
        print()
        print("Before showing a prediction to anyone, read the limits in")
        print("docs/POINTNET_MODEL.md section 6. In particular Max_Distance is")
        print("shrunk toward the mean and never exceeds ~19,800 m, so it must not")
        print("be used to rank or search designs.")
    else:
        print("NOT VERIFIED — do not use the model until the failures above are fixed.")
    print("=" * 70)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
