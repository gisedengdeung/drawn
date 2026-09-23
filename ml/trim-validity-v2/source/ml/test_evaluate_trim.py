"""Synthetic regression tests for trim evaluation and calibration isolation."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import torch
import unittest

import numpy as np

from evaluate_trim import (
    assert_family_separation, baseline_predictions, calibrate_intervals,
    calibration_by_decile, classification_score, fit_baselines, interval_bounds,
    interval_comparison, interval_coverage, score, select_threshold, valid_intervals,
)
from prepare_targets import assign_split


class TrimEvaluationTests(unittest.TestCase):
    def test_r2_uses_train_mean_and_rejects_failed_predictions(self):
        result = score(np.array([2., 4.]), np.array([3., 3.]), train_mean=0.)
        self.assertAlmostEqual(result['r2'], 0.9)
        self.assertEqual(result['mae'], 1)
        self.assertIsNone(score(np.zeros(2), np.ones(2), 0)['r2'])
        self.assertEqual(score(np.array([]), np.array([]), 0)['n'], 0)
        with self.assertRaisesRegex(ValueError, 'finite'):
            score(np.array([1.]), np.array([np.nan]), 0)

    def test_disconnected_intervals_and_empty_support_are_retained(self):
        truth = np.array([[1, 1, 0, 1, 0, 1, 1], [0, 0, 0, 0, 0, 0, 0]], dtype=bool)
        predicted = np.array([[1, 1, 1, 1, 0, 0, 1], [0, 0, 0, 0, 0, 0, 0]], dtype=bool)
        self.assertEqual(valid_intervals(truth[0]), [[0, 1], [3, 3], [5, 6]])
        self.assertEqual(valid_intervals(truth[1]), [])
        summary, details = interval_comparison(truth, predicted, [10, 20])
        self.assertEqual(details[0]['actual_intervals'], [[0, 1], [3, 3], [5, 6]])
        self.assertEqual(details[1]['iou'], 1)
        self.assertEqual(summary['exact_speed_set_match_fraction'], 0.5)
        self.assertEqual(summary['actual_disconnected_designs'], 1)
        self.assertEqual(summary['endpoint_comparison_designs'], 1)

    def test_threshold_is_selected_from_supplied_validation_rows(self):
        selection = select_threshold(np.array([1, 1, 0, 0]), np.array([.44, .46, .43, .10]))
        self.assertAlmostEqual(selection['threshold'], .44)
        self.assertEqual(selection['selected_on'], 'val')
        self.assertEqual(selection['validation_metrics']['f1'], 1)
        # Once frozen, an adversarial test distribution does not recalibrate it.
        test = classification_score(np.array([0, 0]), np.array([.8, .9]) >= selection['threshold'])
        self.assertEqual(test['fp'], 2)

    def test_interval_methods_handle_signed_zero_and_nonpositive_predictions(self):
        actual, predicted = np.array([-4., 0., 4.]), np.array([-3., 1., 5.])
        signed = calibrate_intervals(actual, predicted, 'pitch')
        self.assertEqual(signed['method'], 'additive')
        self.assertEqual(interval_coverage(signed, actual, predicted)['0.9']['empirical'], 1)
        zeros = calibrate_intervals(np.array([0., 2.]), np.array([0., 1.]), 'drag')
        self.assertEqual(zeros['method'], 'additive')
        positive = calibrate_intervals(np.array([10., 20., 30.]), np.array([5., 10., 15.]), 'power')
        self.assertEqual(positive['method'], 'multiplicative')
        low, high, multiplied = interval_bounds(positive, np.array([7., -1.]), .9)
        self.assertEqual(low[0], 14)
        self.assertEqual(high[0], 14)
        np.testing.assert_array_equal(multiplied, [True, False])
        self.assertLessEqual(low[1], high[1])
        self.assertTrue(np.isfinite(low).all())
        additive = calibrate_intervals(np.array([10., 20.]), np.array([-1., 2.]), 'power')
        self.assertEqual(additive['method'], 'additive')

    def test_baselines_fit_only_training_designs(self):
        mesh = np.arange(1, 5)[:, None] * np.arange(1, 7)[None, :]
        speed = np.arange(51)[None, :]
        raw = np.stack([3 * mesh[:, 0, None] + 2 * speed + 5,
                        -mesh[:, 0, None] + speed - 10], axis=-1).astype(float)
        masks = np.ones(raw.shape, dtype=bool)
        masks[:2, 50] = False
        raw[:2, 50] = np.nan
        splits = np.array(['train', 'train', 'val', 'test'])
        first = fit_baselines(mesh, raw, masks, splits)
        changed = raw.copy()
        changed[2:] += 1e6
        altered_mesh = mesh.copy()
        altered_mesh[2:] += 10000
        second = fit_baselines(altered_mesh, changed, masks, splits)
        for key in ('weights', 'speed_mean', 'feature_mean', 'feature_std'):
            np.testing.assert_allclose(first[key], second[key])
        self.assertAlmostEqual(first['speed_mean'][0, 0], 9.5)
        self.assertAlmostEqual(first['speed_mean'][50, 0], 58.5)
        self.assertEqual(first['speeds_using_global_train_mean'], [[50], [50]])
        predicted = baseline_predictions(first, mesh[2:])['mesh_plus_speed']
        np.testing.assert_allclose(predicted, raw[2:], atol=1e-10)

    def test_families_cannot_cross_or_override_frozen_splits(self):
        families = ['test-family-a', 'test-family-b']
        splits = [assign_split(family) for family in families]
        self.assertTrue(assert_family_separation(families, splits)['passed'])
        wrong = 'test' if splits[0] != 'test' else 'train'
        with self.assertRaisesRegex(ValueError, 'crosses'):
            assert_family_separation([families[0], families[0]], [splits[0], wrong])
        with self.assertRaisesRegex(ValueError, 'frozen hash'):
            assert_family_separation([families[0]], [wrong])

    def test_synthetic_checkpoint_evaluation_writes_complete_strict_json_report(self):
        from dataset_trim import load_trim_bundle, normalization_dict
        from evaluate_trim import main
        from model_trim import TARGET_NAMES, TrimPointNet
        families, counts = [], dict(train=0, val=0, test=0)
        candidate = 0
        while min(counts.values()) < 3:
            family = f'evaluation-integration-{candidate}'
            candidate += 1
            split = assign_split(family)
            if counts[split] < 3:
                families.append(family)
                counts[split] += 1
        splits = np.array([assign_split(family) for family in families])
        count = len(families)
        design_ids = np.arange(1, count + 1, dtype=np.int32)
        generator = np.random.default_rng(14)
        points = generator.uniform(-1, 1, (count, 16, 3)).astype(np.float32)
        raw = (design_ids[:, None, None] * 10 + np.arange(51)[None, :, None]
               + np.arange(6)[None, None, :]).astype(np.float32)
        raw[:, :, 0] -= 60
        raw[:, 0, 1] = 0
        valid = np.ones((count, 51), dtype=bool)
        valid[:, 10:15] = False
        raw[0, 5, 2] = np.nan
        mask = valid[:, :, None] & np.isfinite(raw)
        with tempfile.TemporaryDirectory(prefix='trim-evaluation-test-') as directory:
            root = Path(directory)
            points_path, trims_path = root / 'points.npz', root / 'trims.npz'
            np.savez(points_path, design_id=design_ids, points=points,
                     scale=design_ids.astype(float) + 10, family=np.array(families), split=splits,
                     extents=np.ones((count, 3)) * design_ids[:, None],
                     span=design_ids.astype(float), area=design_ids.astype(float) * 20)
            np.savez(trims_path, design_id=design_ids[::-1], trim=raw[::-1], trim_valid=valid[::-1],
                     regression_mask=mask[::-1], family=np.array(families)[::-1], split=splits[::-1],
                     target_names=np.array(TARGET_NAMES))
            bundle = load_trim_bundle(points_path, trims_path, device='cpu')
            config = dict(pool='maxmean', encoder_widths=[4, 8], head_widths=[8], dropout=.1)
            model = TrimPointNet(**config)
            checkpoint = root / 'model.pt'
            torch.save({'state_dict': model.state_dict(), 'model_config': config,
                        'target_names': list(bundle.target_names), 'normalization': normalization_dict(bundle),
                        'best_epoch': 1, 'data_paths': {'points': str(points_path), 'trims': str(trims_path)}}, checkpoint)
            report_path, predictions_dir = root / 'report.json', root / 'predictions'
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(['--checkpoint', str(checkpoint), '--report', str(report_path),
                                       '--predictions-dir', str(predictions_dir), '--device', 'cpu',
                                       '--batch-size', '2', '--resample-designs', '0']), 0)
            report = json.loads(report_path.read_text(encoding='utf-8'))
            json.dumps(report, allow_nan=False)
            self.assertEqual(report['validity']['threshold_selection']['selected_on'], 'val')
            self.assertEqual(len(report['model_version']['checkpoint']['sha256']), 64)
            self.assertTrue(report['model_version']['split_validation']['passed'])
            self.assertEqual(report['model_version']['split_sizes'], {'train': 3, 'val': 3, 'test': 3})
            self.assertEqual(set(report['targets']), set(TARGET_NAMES))
            with np.load(predictions_dir / 'test_predictions.npz') as saved:
                self.assertEqual(saved['predicted'].shape, (3, 51, 6))
                for column, name in enumerate(TARGET_NAMES):
                    entry = report['targets'][name]['test']
                    self.assertEqual(entry['speed0_included']['model']['n'], int(saved['actual_mask'][:, :, column].sum()))
                    self.assertEqual(entry['speed0_excluded']['model']['n'], int(saved['actual_mask'][:, 1:, column].sum()))
                    self.assertIn('mesh_plus_speed', entry['speed0_included']['baselines'])
                    self.assertIn('0.9', entry['speed0_included']['interval_coverage'])
            self.assertTrue((predictions_dir / 'valid_speed_intervals.csv').is_file())
    def test_shrinkage_deciles_remain_json_finite_for_zero_and_signed_values(self):
        actual = np.linspace(-10, 10, 100)
        calibration = calibration_by_decile(actual, actual * .5)
        self.assertEqual(len(calibration['deciles']), 10)
        self.assertAlmostEqual(calibration['top_decile_ratio'], .5)
        zero = calibration_by_decile(np.zeros(20), np.ones(20))
        self.assertIsNone(zero['top_decile_ratio'])
        json.dumps(zero, allow_nan=False)


if __name__ == '__main__':
    unittest.main()
