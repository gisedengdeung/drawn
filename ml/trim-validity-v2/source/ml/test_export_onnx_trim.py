"""Focused split-graph export tests using a small real TrimPointNet on CPU."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

from export_onnx_trim import TARGET_NAMES, TrimHead, main as export_main, sha256, threshold_metadata
from model_trim import TrimPointNet
from verify_onnx_trim import main as verify_main
from predict_trim import main as predict_main, summarize


class ExportTrimTests(unittest.TestCase):
    def test_public_curve_masks_invalid_or_negative_estimates(self):
        runs = np.ones((2, 51, 6), dtype=np.float64)
        probabilities = np.ones((2, 51), dtype=np.float64)
        runs[:, 1, 4] = -5.0
        probabilities[:, 2] = 0.1
        curve, diagnostics = summarize(runs, probabilities, 0.6)
        self.assertTrue(curve[0]["usable_prediction"])
        self.assertEqual(curve[0]["estimates"]["distance"], 0.0)
        self.assertFalse(curve[1]["physical_bounds_ok"])
        self.assertTrue(curve[1]["classifier_valid"])
        self.assertTrue(all(value is None for value in curve[1]["estimates"].values()))
        self.assertTrue(all(value is None for value in curve[2]["estimates"].values()))
        self.assertEqual(diagnostics["raw_estimate_mean"][1][4], -5.0)
        self.assertEqual(len(diagnostics["mean_physical_bound_violations"]), 1)

    def test_inverse_target_transform_and_probability(self):
        class FixedNet(torch.nn.Module):
            def decode(self, features, speed):
                return torch.zeros((1, 1, 6)), torch.zeros((1, 1))

        mean = [-2.0, -1.0, 0.0, 1.0, 2.0, 3.0]
        for transform in ("raw", "signed_log1p"):
            head = TrimHead(FixedNet(), {"target_mean": mean, "target_std": [2.0] * 6,
                                        "target_transform": transform})
            trim, valid = head(torch.zeros(1, 1), torch.ones(1, 1))
            expected = np.array(mean)
            if transform == "signed_log1p":
                expected = np.sign(expected) * np.expm1(np.abs(expected))
            np.testing.assert_allclose(trim.numpy()[0, 0], expected, rtol=1e-6)
            self.assertEqual(valid.item(), 0.5)

    def test_export_and_receiver_for_both_transforms(self):
        torch.set_num_threads(2)
        torch.manual_seed(42)
        config = {"pool": "maxmean", "encoder_widths": [8, 16],
                  "head_widths": [16, 8], "dropout": 0.1}
        net = TrimPointNet(**config).eval()
        with tempfile.TemporaryDirectory(prefix="trim-onnx-") as folder:
            root = Path(folder)
            points_path = root / "points.npz"
            rng = np.random.default_rng(1)
            points = rng.normal(size=(3, 32, 3)).astype(np.float32)
            points -= points.mean(axis=1, keepdims=True)
            points /= np.max(np.abs(points), axis=(1, 2), keepdims=True)
            np.savez(points_path, design_id=np.arange(1, 4), points=points,
                     scale=np.array([200, 500, 1200], dtype=np.float32),
                     centroid=np.array([[10, 20, 30]] * 3, dtype=np.float32))
            for transform in ("raw", "signed_log1p"):
                with self.subTest(transform=transform):
                    checkpoint_path = root / f"{transform}.pt"
                    checkpoint = {
                        "state_dict": net.state_dict(), "model_config": config,
                        "target_names": TARGET_NAMES,
                        "normalization": {"target_mean": [-1, 1, 2, 3, 4, 5],
                                          "target_std": [0.3] * 6, "scale_log_mean": 6.0,
                                          "scale_log_std": 0.5, "target_transform": transform},
                        "data_paths": {"points": str(points_path)}, "best_epoch": 1,
                    }
                    torch.save(checkpoint, checkpoint_path)
                    evaluation_path = root / "evaluation.json"
                    evaluation_path.write_text(json.dumps({
                        "model_version": {"checkpoint": {"sha256": sha256(checkpoint_path)}},
                        "validity": {"threshold_selection": {"threshold": 0.65,
                                                              "selected_on": "val", "method": "test fixture"}},
                    }), encoding="utf-8")
                    manifest = root / "reports/manifest.json"
                    arguments = ["--checkpoint", str(checkpoint_path),
                                 "--encoder", str(root / "encoder.onnx"),
                                 "--head", str(root / "head.onnx"),
                                 "--manifest", str(manifest),
                                 "--vectors", str(root / "reports/vectors.json"),
                                 "--evaluation", str(evaluation_path), "--verify-designs", "3", "--threads", "2"]
                    self.assertEqual(export_main(arguments), 0)
                    self.assertEqual(verify_main(["--manifest", str(manifest)]), 0)
                    exported = json.loads(manifest.read_text(encoding="utf-8"))
                    self.assertEqual(exported["validity"]["threshold"], 0.65)
                    if transform == "raw":
                        import trimesh
                        stl_path = root / "shape.stl"
                        trimesh.creation.box(extents=[100.0, 200.0, 50.0]).export(stl_path)
                        output_path = root / "prediction.json"
                        self.assertEqual(predict_main([
                            "--stl", str(stl_path), "--manifest", str(manifest),
                            "--repeat", "2", "--seed", "42", "--out", str(output_path),
                        ]), 0)
                        predicted = json.loads(output_path.read_text(encoding="utf-8"))
                        self.assertEqual(len(predicted["curve"]), 51)
                        self.assertEqual(predicted["sampling"]["repeats"], 2)
                        self.assertEqual(predicted["source_checkpoint_sha256"], sha256(checkpoint_path))
                        self.assertTrue(output_path.with_suffix(".csv").is_file())
                    # A corrupted or replaced graph must fail before runtime use.
                    with (root / "head.onnx").open("ab") as handle:
                        handle.write(b"corruption")
                    self.assertEqual(verify_main(["--manifest", str(manifest)]), 1)
                    with self.assertRaisesRegex(ValueError, "SHA256"):
                        evaluation_path.write_text(json.dumps({"model_version": {"checkpoint": {"sha256": "wrong"}}}), encoding="utf-8")
                        threshold_metadata(evaluation_path, checkpoint_path, manifest)


if __name__ == "__main__":
    unittest.main()
