"""Regression tests for the conditional PointNet architecture."""
import unittest
import torch
from model import PointNetEncoder
from model_trim import TrimPointNet


class TrimModelTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(2)
        torch.manual_seed(2)
        self.model = TrimPointNet(encoder_widths=(8, 16), head_widths=(12, 8), dropout=0.0).eval()
        self.points = torch.randn(3, 3, 32)
        self.scale = torch.randn(3, 1)

    def test_encoder_once_all_speeds_and_point_order_invariance(self):
        calls = []
        hook = self.model.encoder.register_forward_hook(lambda *args: calls.append(1))
        regression, validity = self.model(self.points, self.scale)
        hook.remove()
        self.assertIsInstance(self.model.encoder, PointNetEncoder)
        self.assertEqual(len(calls), 1)
        self.assertEqual(tuple(regression.shape), (3, 51, 6))
        self.assertEqual(tuple(validity.shape), (3, 51))
        shuffled = self.model(self.points[:, :, torch.randperm(32)], self.scale)
        torch.testing.assert_close(regression, shuffled[0], atol=1e-6, rtol=1e-6)
        torch.testing.assert_close(validity, shuffled[1], atol=1e-6, rtol=1e-6)

    def test_fast_projection_matches_concatenation_and_single_speed(self):
        features = self.model.encode(self.points, self.scale)
        speeds = torch.tensor([[0., 12., 50.]]).expand(3, -1)
        actual = self.model.decode(features, speeds)
        expanded = features[:, None, :].expand(-1, 3, -1)
        hidden = self.model.first(torch.cat([expanded, (speeds / 50).unsqueeze(-1)], -1))
        hidden = self.model.hidden(self.model.activation(hidden))
        expected = (self.model.regression(hidden), self.model.validity(hidden).squeeze(-1))
        torch.testing.assert_close(actual[0], expected[0])
        torch.testing.assert_close(actual[1], expected[1])
        single = self.model.decode(features, speeds[:, 1:2])
        torch.testing.assert_close(single[0], actual[0][:, 1:2])
        torch.testing.assert_close(single[1], actual[1][:, 1:2])

    def test_both_heads_backpropagate(self):
        self.model.train()
        regression, logit = self.model(self.points, self.scale)
        loss = regression.square().mean() + torch.nn.functional.binary_cross_entropy_with_logits(logit, torch.zeros_like(logit))
        loss.backward()
        for module in (self.model.encoder, self.model.regression, self.model.validity):
            self.assertTrue(any(p.grad is not None and p.grad.abs().sum() > 0 for p in module.parameters()))


if __name__ == '__main__':
    unittest.main()
