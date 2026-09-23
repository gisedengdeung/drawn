"""Regression checks for trim validity, ID joins and train-only normalization."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from common import TRIM_FIELDS, trim_row_valid
from dataset_trim import inverse_targets, load_trim_bundle, normalization_dict
from prepare_targets import assign_split
from prepare_trims import TARGET_NAMES, extract_trim_supervision, prepare_trims


def family_for(split, suffix=''):
    for index in range(10000):
        family = f'design_{index}_{index:032x}{suffix}'
        if assign_split(family) == split:
            return family
    raise AssertionError('No fixture family')


class TrimDatasetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='trim-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.points_path = self.root / 'points.npz'
        self.trims_path = self.root / 'trims.npz'
        self.families = np.array([family_for('train'), family_for('train', 'b'),
                                  family_for('val'), family_for('test')])
        self.splits = np.array(['train', 'train', 'val', 'test'])
        self.raw = np.zeros((4, 51, 6), dtype=np.float32)
        self.raw[0, 0] = [-2, 0, 10, 20, 30, 40]
        self.raw[0, 7] = [-4, np.nan, 20, 40, 60, 80]
        self.raw[2, 1] = [1000, 2000, 3000, 4000, 5000, 6000]
        self.raw[3, 2] = [10000, 20000, 30000, 40000, 50000, 60000]
        self.valid = np.zeros((4, 51), dtype=bool)
        self.valid[0, [0, 7]] = True
        self.valid[2, 1] = self.valid[3, 2] = True
        self.trim_payload = {
            'design_id': np.array([1, 2, 3, 4], dtype=np.int32), 'trim': self.raw,
            'trim_valid': self.valid, 'regression_mask': self.valid[:, :, None] & np.isfinite(self.raw),
            'split': self.splits, 'family': self.families, 'target_names': np.array(TARGET_NAMES),
        }
        order = np.array([2, 0, 3, 1])
        self.point_payload = {
            'design_id': np.array([1, 2, 3, 4], dtype=np.int32)[order],
            'points': np.repeat(np.arange(1, 5, dtype=np.float32)[:, None, None], 12, axis=1).reshape(4, 4, 3)[order],
            'scale': np.array([2, 8, 100, 1000], dtype=np.float32)[order],
            'split': self.splits[order], 'family': self.families[order],
        }
        self.save()

    def save(self):
        np.savez(self.points_path, **self.point_payload)
        np.savez(self.trims_path, **self.trim_payload)

    def load(self, **kwargs):
        return load_trim_bundle(self.points_path, self.trims_path, device='cpu', **kwargs)

    def test_validity_matches_common_and_masks_nan_only_for_that_target(self):
        full = np.zeros((51, 12), dtype=np.float64)
        full[3, TRIM_FIELDS.index('power')] = 10
        full[3, TRIM_FIELDS.index('drag')] = np.nan
        full[4, TRIM_FIELDS.index('maxUc')] = 0.5
        full[5] = np.nan
        full[6, TRIM_FIELDS.index('pitch')] = -4
        targets, valid, mask = extract_trim_supervision(full)
        np.testing.assert_array_equal(valid, [trim_row_valid(row) for row in full])
        self.assertTrue(valid[3] and valid[4] and valid[6])
        self.assertFalse(valid[5])
        self.assertFalse(mask[3, TARGET_NAMES.index('drag')])
        self.assertEqual(int(mask[3].sum()), 5)
        self.assertTrue(mask[4].all())
        self.assertEqual(targets[6, 0], -4)

    def test_id_join_all_designs_and_train_only_stats(self):
        bundle = self.load()
        np.testing.assert_array_equal(bundle.design_id, [3, 1, 4, 2])
        np.testing.assert_allclose(bundle.mean, [-3, 0, 15, 30, 45, 60])
        np.testing.assert_allclose(bundle.raw_mean, bundle.mean)
        self.assertAlmostEqual(bundle.scale_log_mean, np.log(4))
        self.assertAlmostEqual(bundle.scale_log_std, np.log(2))
        self.assertEqual(tuple(bundle.points.shape), (4, 3, 4))
        self.assertTrue(torch.equal(bundle.points[1], torch.ones((3, 4))))
        self.assertFalse(bundle.valid[3].any())
        self.assertTrue(np.isnan(bundle.raw_targets[3]).all())
        self.assertEqual(bundle.targets[~bundle.mask].abs().sum().item(), 0)
        self.assertEqual(bundle.targets.isfinite().all().item(), True)
        self.assertEqual(len(bundle.indices['train']), 2)
        decoded = inverse_targets(bundle.targets, bundle).numpy()
        mask = bundle.mask.numpy()
        np.testing.assert_allclose(decoded[mask], bundle.raw_targets[mask], atol=1e-3)

    def test_checkpoint_metadata_uses_native_python_types(self):
        bundle = self.load()
        self.assertTrue(all(type(name) is str for name in bundle.target_names))
        path = self.root / 'checkpoint.pt'
        torch.save({'target_names': bundle.target_names,
                    'normalization': normalization_dict(bundle),
                    'train_mean': bundle.raw_mean.tolist()}, path)
        checkpoint = torch.load(path, weights_only=True)
        self.assertEqual(checkpoint['target_names'], TARGET_NAMES)

    def test_test_exclusion_and_checkpoint_roundtrip(self):
        bundle = self.load(target_transform='signed_log1p', include_test=False)
        self.assertNotIn(4, bundle.design_id)
        self.assertEqual(len(bundle.indices['test']), 0)
        stats = normalization_dict(bundle)
        restored = self.load(normalization=stats, target_transform='raw')
        self.assertEqual(restored.target_transform, 'signed_log1p')
        np.testing.assert_array_equal(restored.mean, bundle.mean)
        np.testing.assert_array_equal(restored.std, bundle.std)
        decoded = inverse_targets(restored.targets.numpy(), stats)
        mask = restored.mask.numpy()
        np.testing.assert_allclose(decoded[mask], restored.raw_targets[mask], rtol=2e-5, atol=1e-4)
        sequential = torch.cat(list(bundle.sequential('train', 1)))
        torch.testing.assert_close(sequential, bundle.indices['train'])

    def test_duplicate_ids_missing_ids_wrong_split_and_family_are_rejected(self):
        self.point_payload['design_id'][1] = 3
        self.save()
        with self.assertRaisesRegex(ValueError, 'duplicate design IDs'):
            self.load()
        self.point_payload['design_id'][1] = 99
        self.save()
        with self.assertRaisesRegex(ValueError, 'different design ID sets'):
            self.load()
        self.point_payload['design_id'][1] = 1
        self.trim_payload['split'][0] = 'test'
        self.save()
        with self.assertRaisesRegex(ValueError, 'assign_split'):
            self.load()
        self.trim_payload['split'][0] = 'train'
        self.trim_payload['family'][0] = self.families[1]
        self.save()
        with self.assertRaisesRegex(ValueError, 'Family mismatch'):
            self.load()

    def test_invalid_regression_mask_is_rejected(self):
        self.trim_payload['regression_mask'][0, 7, 1] = True
        self.save()
        with self.assertRaisesRegex(ValueError, 'Regression mask'):
            self.load()

    def test_prepare_keeps_all_invalid_design_and_original_family_split(self):
        part = self.root / 'AircraftVerse_1'
        family = family_for('train')
        for design_id in (2, 1):
            directory = part / f'design_{design_id}'
            directory.mkdir(parents=True)
            (directory / 'design_low_level.json').write_text(json.dumps({'name': family + '_dw'}))
            full = np.zeros((51, 12), dtype=np.float64)
            if design_id == 1:
                full[0, TRIM_FIELDS.index('power')] = 100
                full[0, TRIM_FIELDS.index('drag')] = np.nan
            np.save(directory / 'trims.npy', full)
        with contextlib.redirect_stdout(io.StringIO()):
            report = prepare_trims([part], self.root / 'prepared.npz', self.root / 'report.json')
        self.assertEqual(report['designs'], 2)
        self.assertEqual(report['designs_without_valid_trim'], 1)
        with np.load(self.root / 'prepared.npz') as data:
            np.testing.assert_array_equal(data['design_id'], [1, 2])
            np.testing.assert_array_equal(data['family'], [family, family])
            np.testing.assert_array_equal(data['split'], ['train', 'train'])
            self.assertEqual(int(data['regression_mask'].sum()), 5)


if __name__ == '__main__':
    unittest.main()