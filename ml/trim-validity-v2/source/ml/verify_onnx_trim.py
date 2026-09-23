"""Receiver verification for split trim ONNX artifacts; no PyTorch required.

Copy the manifest, vectors and the two graphs, preserving their relative
paths, or override --encoder/--head/--vectors. Only numpy and onnxruntime are
required. The training checkpoint and point-cloud dataset are not required.

    python ml/verify_onnx_trim.py --manifest ml/reports/trim_onnx_manifest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check(label: str, passed: bool, detail: str = "") -> bool:
    print(f"[{'PASS' if passed else 'FAIL'}] {label}" + (f": {detail}" if detail else ""))
    return bool(passed)


def close(actual: np.ndarray, expected: np.ndarray, rtol: float, atol: float) -> bool:
    return bool(actual.shape == expected.shape and np.isfinite(actual).all()
                and np.isfinite(expected).all() and np.allclose(actual, expected, rtol=rtol, atol=atol))


def signature_matches(session, specification: dict) -> bool:
    for produced, direction in ((session.get_inputs(), "inputs"), (session.get_outputs(), "outputs")):
        promised = specification[direction]
        if [item.name for item in produced] != list(promised):
            return False
        for item in produced:
            expected = promised[item.name]
            if item.type != "tensor(float)" or len(item.shape) != len(expected["shape"]):
                return False
            if any(isinstance(dim, int) and actual != dim
                   for actual, dim in zip(item.shape, expected["shape"])):
                return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "ml/reports/trim_onnx_manifest.json")
    parser.add_argument("--encoder", type=Path)
    parser.add_argument("--head", type=Path)
    parser.add_argument("--vectors", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args(argv)
    if args.threads < 1:
        parser.error("threads must be positive")
    if not args.manifest.is_file():
        print(f"Manifest not found: {args.manifest}. Run ml/export_onnx_trim.py first.")
        return 2
    try:
        import onnxruntime as ort
    except ImportError:
        print("Install receiver dependencies: python -m pip install numpy onnxruntime")
        return 2
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        print("Unsupported manifest schema")
        return 2
    paths = {name: override or args.manifest.parent / manifest["files"][name]["path"]
             for name, override in (("encoder", args.encoder), ("head", args.head),
                                    ("test_vectors", args.vectors))}
    results = []
    for name, path in paths.items():
        if not path.is_file():
            print(f"Missing {name}: {path}")
            return 2
        expected = manifest["files"][name]
        results.append(check(f"{name} SHA256", sha256(path) == expected["sha256"]
                             and path.stat().st_size == expected["bytes"]))
    if not all(results):
        print("NOT VERIFIED: graph or vector files differ from the manifest")
        return 1
    results.append(check("exporter numerical verification", manifest.get("verification_passed") is True))
    vectors = json.loads(paths["test_vectors"].read_text(encoding="utf-8"))
    entries = vectors.get("vectors", [])
    if not entries or vectors.get("target_order") != manifest["target_order"]:
        print("Test vectors are missing or have a different target order")
        return 2
    tolerances = vectors["tolerances"]
    rtol, trim_atol, valid_atol = (float(tolerances[key])
                                  for key in ("rtol", "trim_atol", "valid_atol"))
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    encoder, head = [ort.InferenceSession(str(paths[name]), options,
                                        providers=["CPUExecutionProvider"])
                     for name in ("encoder", "head")]
    results.append(check("encoder signature", signature_matches(encoder, manifest["io"]["encoder"])))
    results.append(check("head signature", signature_matches(head, manifest["io"]["head"])))
    rng = np.random.default_rng(42)
    for entry in entries:
        points = np.asarray(entry["points_mm"], dtype=np.float32)[None]
        speeds = np.asarray(entry["speed"], dtype=np.float32)[None]
        expected_trim = np.asarray(entry["expected_trim"], dtype=np.float32)[None]
        expected_valid = np.asarray(entry["expected_valid"], dtype=np.float32)[None]
        features = encoder.run(["design_features"], {"points_mm": points})[0]
        trim, valid = head.run(["trim", "valid"], {"design_features": features, "speed": speeds})
        label = f"design {entry['design_id']}"
        results.append(check(f"{label} physical-unit output", close(trim, expected_trim, rtol, trim_atol)))
        results.append(check(f"{label} validity probability", close(valid, expected_valid, rtol, valid_atol)
                             and bool(np.all((valid >= 0) & (valid <= 1)))))
        # A slider call must give the same result as the corresponding full curve.
        index = min(13, speeds.shape[1] - 1)
        single_trim, single_valid = head.run(["trim", "valid"],
                                            {"design_features": features, "speed": speeds[:, index:index + 1]})
        results.append(check(f"{label} dynamic speed length 1 and 51",
                             speeds.shape[1] == 51
                             and close(single_trim, trim[:, index:index + 1], rtol, trim_atol)
                             and close(single_valid, valid[:, index:index + 1], rtol, valid_atol)))
        shuffled = points.copy()
        rng.shuffle(shuffled[0])
        shuffled_features = encoder.run(["design_features"], {"points_mm": shuffled})[0]
        shuffled_trim, shuffled_valid = head.run(["trim", "valid"],
                                                {"design_features": shuffled_features, "speed": speeds})
        results.append(check(f"{label} point permutation",
                             close(shuffled_trim, trim, rtol, trim_atol)
                             and close(shuffled_valid, valid, rtol, valid_atol)))
    # Verify batch 2 also works, using two different test vectors when available.
    batch_entries = [entries[0], entries[min(1, len(entries) - 1)]]
    batch_points = np.asarray([entry["points_mm"] for entry in batch_entries], dtype=np.float32)
    batch_speed = np.asarray([entry["speed"] for entry in batch_entries], dtype=np.float32)
    batch_features = encoder.run(["design_features"], {"points_mm": batch_points})[0]
    batch_trim, batch_valid = head.run(["trim", "valid"],
                                      {"design_features": batch_features, "speed": batch_speed})
    results.append(check("dynamic batch 2",
                         close(batch_trim, np.asarray([entry["expected_trim"] for entry in batch_entries], dtype=np.float32), rtol, trim_atol)
                         and close(batch_valid, np.asarray([entry["expected_valid"] for entry in batch_entries], dtype=np.float32), rtol, valid_atol)))
    validity = manifest["validity"]
    if validity.get("status") == "calibrated_on_validation":
        results.append(check("validation-calibrated threshold",
                             validity.get("selected_on") == "val" and 0 < float(validity["threshold"]) < 1,
                             str(validity["threshold"])))
    else:
        print("[PENDING] Feasibility threshold has not been calibrated; output remains probability only.")
    passed = all(results)
    print("VERIFIED" if passed else "NOT VERIFIED")
    print(f"Target order: {manifest['target_order']}")
    print("distance [m] = speed [m/s] * trim[..., 3] [s]; lift is not predicted.")
    print("Verification confirms artifact/runtime agreement, not predictive accuracy.")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
