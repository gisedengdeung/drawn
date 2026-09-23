"""Synthetic CPU checks for the independent validity head and training loss."""
import unittest

import numpy as np
import torch

from model_trim import TrimPointNet
from model_validity_v2 import TrimValidityV2
from train_validity_v2 import choose_threshold, cls_loss


def make_model():
    torch.manual_seed(19)
    config = dict(encoder_widths=(4, 8), head_widths=(8, 6), dropout=.15)
    baseline = TrimPointNet(**config).eval()
    model = TrimValidityV2(validity_widths=(7,), validity_dropout=.15, **config).eval()
    incompatible = model.load_state_dict(baseline.state_dict(), strict=False)
    return baseline, model, incompatible


class ValidityModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_loaded_baseline_regression_is_preserved_exactly(self):
        baseline, model, incompatible = make_model()
        self.assertEqual(incompatible.unexpected_keys, [])
        self.assertTrue(incompatible.missing_keys)
        self.assertTrue(all(key.startswith('speed_set.') for key in incompatible.missing_keys))
        points, scale = torch.randn(3, 3, 20), torch.randn(3, 1)
        speed = torch.tensor([[0., 1.5, 50.], [7., 3., 11.], [50., 0., 2.]])
        with torch.no_grad():
            original, _ = baseline(points, scale, speed)
            replacement, _ = model(points, scale, speed)
        torch.testing.assert_close(replacement, original, rtol=0, atol=0)
        optimizer = torch.optim.SGD(model.speed_set.parameters(), lr=.2)
        _, logits = model(points, scale, speed)
        logits.square().mean().backward()
        optimizer.step()
        with torch.no_grad():
            after_step, _ = model(points, scale, speed)
        torch.testing.assert_close(after_step, original, rtol=0, atol=0)

    def test_integer_grid_returns_native_head_logits_exactly(self):
        _, model, _ = make_model()
        points, scale = torch.randn(3, 3, 16), torch.randn(3, 1)
        with torch.no_grad():
            features = model.encode(points, scale)
            expected = model.speed_set(features)
            regression, logits = model(points, scale)
        self.assertEqual(regression.shape, (3, 51, 6))
        torch.testing.assert_close(logits, expected, rtol=0, atol=0)

    def test_fractional_speeds_interpolate_logits_and_clamp_endpoints(self):
        _, model, _ = make_model()
        features = torch.randn(2, model.feature_dim)
        speed = torch.tensor([[0., .25, 3.5, 50., 53.], [7.75, 12.2, 49.9, -3., 0.]])
        with torch.no_grad():
            grid = model.speed_set(features)
            _, logits = model.decode(features, speed)
            expected = torch.empty_like(speed)
            for i in range(len(features)):
                for j in range(speed.shape[1]):
                    position = speed[i, j].clamp(0, 50)
                    lower = int(position.floor())
                    upper = min(lower + 1, 50)
                    fraction = position - lower
                    expected[i, j] = grid[i, lower] * (1 - fraction) + grid[i, upper] * fraction
        torch.testing.assert_close(logits, expected, rtol=0, atol=0)

    def test_dynamic_batch_and_speed_count(self):
        _, model, _ = make_model()
        for batch, speeds in [(1, 1), (2, 7), (4, 51), (3, 4)]:
            points, scale = torch.randn(batch, 3, 11), torch.randn(batch, 1)
            speed = torch.rand(batch, speeds) * 50
            with torch.no_grad():
                regression, logits = model(points, scale, speed)
            self.assertEqual(regression.shape, (batch, speeds, 6))
            self.assertEqual(logits.shape, (batch, speeds))
            self.assertTrue(torch.isfinite(regression).all())
            self.assertTrue(torch.isfinite(logits).all())

    def test_training_gradients_are_finite(self):
        _, model, _ = make_model()
        model.train()
        points, scale = torch.randn(4, 3, 20), torch.randn(4, 1)
        truth = torch.zeros(4, 51)
        truth[:, [0, 2, 5, 8]] = 1
        observed = torch.ones_like(truth)
        observed[0, 0] = 0
        regression, logits = model(points, scale)
        loss = cls_loss(logits, truth, observed, 2.5, .5, .25) + regression.square().mean()
        self.assertTrue(torch.isfinite(loss))
        loss.backward()
        for name, parameter in model.named_parameters():
            if parameter.grad is not None:
                self.assertTrue(torch.isfinite(parameter.grad).all(), name)
        self.assertIsNotNone(model.speed_set.layers[0].weight.grad)
        self.assertGreater(float(model.speed_set.layers[0].weight.grad.abs().sum()), 0)

    def test_masked_labels_and_logits_do_not_change_loss_or_observed_gradients(self):
        torch.manual_seed(11)
        truth = torch.randint(0, 2, (3, 51)).float()
        observed = (torch.rand(3, 51) > .3).float()
        logits = torch.randn(3, 51, requires_grad=True)
        changed_truth = torch.where(observed.bool(), truth, 1 - truth)
        changed_logits = torch.where(observed.bool(), logits.detach(), torch.full_like(logits, 12.)).requires_grad_()
        first = cls_loss(logits, truth, observed, 2.3, .5, .25)
        second = cls_loss(changed_logits, changed_truth, observed, 2.3, .5, .25)
        torch.testing.assert_close(first, second, rtol=0, atol=0)
        first.backward()
        second.backward()
        torch.testing.assert_close(logits.grad, changed_logits.grad, rtol=0, atol=0)
        self.assertEqual(float(logits.grad[~observed.bool()].abs().sum()), 0)

    def test_no_observed_labels_has_zero_loss_and_finite_zero_gradient(self):
        logits = torch.randn(2, 51, requires_grad=True)
        loss = cls_loss(logits, torch.ones_like(logits), torch.zeros_like(logits), 2., .5, .25)
        self.assertEqual(float(loss), 0)
        loss.backward()
        self.assertTrue(torch.isfinite(logits.grad).all())
        self.assertEqual(float(logits.grad.abs().sum()), 0)

    def test_noncontiguous_holes_and_above_max_penalties_are_separate(self):
        truth = torch.zeros(1, 51)
        truth[:, [2, 4]] = 1
        observed = torch.ones_like(truth)
        good = torch.full_like(truth, -6.)
        good[:, [2, 4]] = 6.
        hole, above, below = good.clone(), good.clone(), good.clone()
        hole[:, 3] = above[:, 5] = below[:, 1] = 6.

        def penalty(logits, set_weight=0., upper_weight=0.):
            return (cls_loss(logits, truth, observed, set_weight=set_weight, upper_weight=upper_weight)
                    - cls_loss(logits, truth, observed))

        self.assertGreater(float(penalty(hole, set_weight=1)), float(penalty(good, set_weight=1)))
        self.assertGreater(float(penalty(above, set_weight=1)), float(penalty(good, set_weight=1)))
        torch.testing.assert_close(penalty(hole, upper_weight=1), penalty(good, upper_weight=1))
        torch.testing.assert_close(penalty(below, upper_weight=1), penalty(good, upper_weight=1))
        self.assertGreater(float(penalty(above, upper_weight=1)), float(penalty(good, upper_weight=1)))
        self.assertGreater(float(cls_loss(hole, truth, observed, set_weight=.5)),
                           float(cls_loss(good, truth, observed, set_weight=.5)))

    def test_threshold_selection_handles_empty_and_false_positive_only_ties(self):
        truth = np.zeros((2, 51), dtype=bool)
        truth[0, 0] = True
        probability = np.zeros((2, 51))
        probability[1, 4] = .4
        observed = np.ones_like(truth)
        score, threshold, metrics = choose_threshold(truth, probability, observed, minimum_recall=.6)
        self.assertTrue(np.isfinite(score))
        self.assertTrue(.1 <= threshold <= .9)
        self.assertEqual(metrics['recall'], 0)


if __name__ == '__main__':
    unittest.main()
