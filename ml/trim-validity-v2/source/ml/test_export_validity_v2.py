"""CPU checkpoint-build tests for the backward-compatible split ONNX wrappers."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import torch

from export_onnx_trim import TARGET_NAMES, build
from model_trim import TrimPointNet
from model_validity_v2 import TrimValidityV2
from model_validity_dual import TrimValidityDual


class ExportValidityV2Tests(unittest.TestCase):
    def test_build_legacy_v2_and_dual_preserves_wrapper_contract(self):
        torch.set_num_threads(2)
        torch.manual_seed(42)
        base_config = {"pool": "maxmean", "encoder_widths": [8, 16],
                       "head_widths": [16, 8], "dropout": 0.1}
        normalization = {"target_mean": [-1, 1, 2, 3, 4, 5],
                         "target_std": [0.3] * 6, "scale_log_mean": 6.0,
                         "scale_log_std": 0.5, "target_transform": "raw"}
        raw_points = torch.randn(2, 32, 3) * 500 + 100
        centered = raw_points - raw_points.mean(dim=1, keepdim=True)
        scale = centered.abs().amax(dim=(1, 2)).clamp_min(1e-6)
        normalized = centered / scale[:, None, None]
        scale_feature = ((scale.log() - 6.0) / 0.5)[:, None]
        speed_vectors = (torch.tensor([13.0]), torch.arange(51, dtype=torch.float32),
                         torch.tensor([0.0, 0.5, 13.25, 49.75, 50.0]))
        with tempfile.TemporaryDirectory(prefix="trim-v2-build-") as folder:
            for kind in (None, "trim_validity_v2", "trim_validity_dual"):
                with self.subTest(model_kind=kind):
                    config = dict(base_config)
                    model_class = TrimPointNet
                    if kind in ("trim_validity_v2", "trim_validity_dual"):
                        config.update(validity_widths=[12, 8], validity_dropout=0.1)
                        model_class = (TrimValidityDual if kind == "trim_validity_dual"
                                       else TrimValidityV2)
                    original = model_class(**config).eval()
                    checkpoint = {"state_dict": original.state_dict(),
                                  "model_config": config, "target_names": TARGET_NAMES,
                                  "normalization": normalization}
                    if kind is not None:
                        checkpoint["model_kind"] = kind
                    path = Path(folder) / f"{kind or 'legacy'}.pt"
                    torch.save(checkpoint, path)
                    encoder, head, loaded = build(path)
                    self.assertIs(type(encoder.net), model_class)
                    self.assertIs(head.net, encoder.net)
                    self.assertEqual(loaded.get("model_kind"), kind)
                    with torch.inference_mode():
                        features = encoder(raw_points)
                        expected_features = original.encode(normalized.transpose(1, 2), scale_feature)
                        torch.testing.assert_close(features, expected_features)
                        for vector in speed_vectors:
                            speed = vector[None].repeat(2, 1)
                            trim, probability = head(features, speed)
                            regression, logits = original.decode(expected_features, speed)
                            self.assertEqual(trim.shape, (2, len(vector), 6))
                            self.assertEqual(probability.shape, (2, len(vector)))
                            torch.testing.assert_close(
                                trim, regression * torch.tensor(normalization["target_std"])
                                + torch.tensor(normalization["target_mean"]))
                            torch.testing.assert_close(probability, logits.sigmoid())
                        if kind in ("trim_validity_v2", "trim_validity_dual"):
                            classifier_features = expected_features
                            if kind == "trim_validity_dual":
                                self.assertEqual(features.shape[1], 2 * original.regression_feature_dim)
                                classifier_features = expected_features[:, original.regression_feature_dim:]
                            grid = original.speed_set(classifier_features)
                            expected_logits = torch.stack([
                                grid[:, 0], (grid[:, 0] + grid[:, 1]) / 2,
                                grid[:, 13] * 0.75 + grid[:, 14] * 0.25,
                                grid[:, 49] * 0.25 + grid[:, 50] * 0.75, grid[:, 50],
                            ], dim=1)
                            torch.testing.assert_close(probability, expected_logits.sigmoid())


if __name__ == "__main__":
    unittest.main()
