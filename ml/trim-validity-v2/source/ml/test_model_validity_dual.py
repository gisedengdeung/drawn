"""Synthetic tests for the independent validity encoder; no dataset is accessed."""
import unittest

import torch

from model_validity_v2 import TrimValidityV2
from model_validity_dual import TrimValidityDual


class TrimValidityDualTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(17)
        self.config = dict(encoder_widths=(8, 16), head_widths=(12, 8),
                           pool='maxmean', dropout=.2,
                           validity_widths=(12, 8), validity_dropout=.15)
        self.base = TrimValidityV2(**self.config).eval()
        self.dual = TrimValidityDual(**self.config).initialize_from_v2(self.base.state_dict()).eval()
        self.points = torch.randn(3, 3, 32)
        self.scale = torch.randn(3, 1)

    def test_regression_and_initial_validity_match_exactly(self):
        speeds = torch.tensor([[0., 7.25, 19., 50.]]).expand(3, -1)
        with torch.no_grad():
            expected = self.base(self.points, self.scale, speeds)
            actual = self.dual(self.points, self.scale, speeds)
        self.assertTrue(torch.equal(actual[0], expected[0]))
        self.assertTrue(torch.equal(actual[1], expected[1]))
        self.assertEqual(self.dual.feature_dim, 66)
        self.assertEqual(self.dual.regression_feature_dim, 33)
        self.assertEqual(self.dual.speed_set.feature_mean.numel(), 33)
        for old, new in zip(self.dual.encoder.parameters(), self.dual.validity_encoder.parameters()):
            self.assertNotEqual(old.data_ptr(), new.data_ptr())
            self.assertFalse(old.requires_grad)
            self.assertTrue(new.requires_grad)

    def test_classifier_update_preserves_regression_and_encoder_buffers(self):
        with torch.no_grad():
            reference = self.base(self.points, self.scale)[0]
        original_state = {key: value.clone() for key, value in self.dual.state_dict().items()
                          if not key.startswith(('validity_encoder.', 'speed_set.'))}
        self.dual.train()
        self.assertFalse(self.dual.encoder.training)
        self.assertFalse(self.dual.dropout.training)
        self.assertFalse(self.dual.hidden.training)
        self.assertTrue(self.dual.validity_encoder.training)
        self.assertTrue(self.dual.speed_set.training)
        parameters = list(self.dual.validity_encoder.parameters()) + list(self.dual.speed_set.parameters())
        optimizer = torch.optim.SGD(parameters, lr=.01)
        logits = self.dual.speed_set(self.dual.encode_validity(self.points, self.scale))
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, torch.zeros_like(logits))
        loss.backward()
        self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0
                            for p in self.dual.validity_encoder.parameters()))
        self.assertTrue(all(p.grad is None for m in self.dual._regression_modules() for p in m.parameters()))
        optimizer.step()
        with torch.no_grad():
            updated = self.dual(self.points, self.scale)[0]
        self.assertTrue(torch.equal(updated, reference))
        for key, value in original_state.items():
            self.assertTrue(torch.equal(self.dual.state_dict()[key], value), key)

    def test_dynamic_batch_points_speed_and_fractional_interpolation(self):
        for batch, point_count, speed_count in ((1, 11, 1), (4, 37, 7)):
            points, scale = torch.randn(batch, 3, point_count), torch.randn(batch, 1)
            speed = torch.linspace(0, 50, speed_count)[None].expand(batch, -1)
            features = self.dual.encode(points, scale)
            regression, logits = self.dual.decode(features, speed)
            self.assertEqual(tuple(features.shape), (batch, self.dual.feature_dim))
            self.assertEqual(tuple(regression.shape), (batch, speed_count, 6))
            self.assertEqual(tuple(logits.shape), (batch, speed_count))
            with torch.no_grad():
                reference = self.base(points, scale, speed)[0]
            self.assertTrue(torch.equal(regression, reference))
        features = self.dual.encode(self.points, self.scale)
        grid = self.dual.speed_set(features[:, self.dual.regression_feature_dim:])
        speed = torch.tensor([[-2., 7., 7.25, 50., 52.]]).expand(3, -1)
        logits = self.dual.decode(features, speed)[1]
        expected = torch.stack([grid[:, 0], grid[:, 7], .75*grid[:, 7]+.25*grid[:, 8], grid[:, 50], grid[:, 50]], 1)
        torch.testing.assert_close(logits, expected, rtol=0, atol=0)
        standard = TrimValidityDual()
        self.assertEqual(standard.feature_dim, 4098)
        self.assertEqual(standard.regression_feature_dim, 2049)
        self.assertEqual(standard.speed_set.feature_mean.numel(), 2049)

    def test_v2_initialization_rejects_missing_regression_keys(self):
        state = dict(self.base.state_dict())
        del state['regression.weight']
        with self.assertRaises(ValueError):
            self.dual.initialize_from_v2(state)


if __name__ == '__main__':
    unittest.main()
