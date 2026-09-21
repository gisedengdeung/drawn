"""Regression coverage for raw AircraftVerse discovery and trim column mapping."""

import contextlib
import csv
import io
import importlib.util
import json
import pickle
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'test-ai-modeling' / 'make_dl_dataset.py'
SPEC = importlib.util.spec_from_file_location('make_dl_dataset', SCRIPT_PATH)
dataset = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dataset)


SCHEMA = [
    'distance', 'flightTime', 'pitch', 'maxUc', 'thrust', 'lift', 'drag',
    'current', 'power', 'motorCurrentRatio', 'motorPowerRatio',
    'batteryCurrentRatio',
]


class DatasetRegressionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='aircraftverse-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def design(self, design_id, feasible=True, category=None):
        result = {'id': design_id, 'feasible': feasible}
        result.update({name: number + 1 for number, name in enumerate(dataset.BASE_FEATURES)})
        result.update({name: category for name in dataset.CAT_FEATURES})
        return result

    def write_index(self, designs, schema=None):
        path = self.root / 'public' / 'data' / 'design-index.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            'summary': {'trimSchema': SCHEMA if schema is None else schema},
            'designs': designs,
        }), encoding='utf-8')

    def write_trims(self, design_id, trims, part=9):
        path = self.root / 'data' / 'raw' / f'AircraftVerse_{part}' / f'design_{design_id}' / 'trims.npy'
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, trims)

    def build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return dataset.build_dataset(self.root)

    def test_sparse_ids_raw_hover_filter_and_named_measurements(self):
        # Index deliberately has neither sourceName nor powerAt0.
        designs = [
            self.design(11), self.design(303, category='component-B'),
            self.design(900), self.design(901), self.design(902),
            self.design(903, feasible=False),
        ]
        self.write_index(designs)
        first = np.zeros((51, 12))
        first[0] = np.arange(101, 113)
        first[7] = np.arange(201, 213)
        first[3] = 300
        first[3, 1] = np.nan
        self.write_trims(11, first, part=9)
        second = np.zeros((51, 12))
        second[0] = np.arange(401, 413)
        second[20] = np.arange(501, 513)
        self.write_trims(303, second, part=2)
        no_hover = np.zeros((51, 12))
        no_hover[20] = np.arange(1, 13)
        self.write_trims(900, no_hover)
        negative_power = second.copy()
        negative_power[0, 8] = -1
        self.write_trims(901, negative_power)
        invalid_hover = second.copy()
        invalid_hover[0, 0] = np.inf
        self.write_trims(902, invalid_hover)
        self.write_trims(903, second)

        report = self.build()
        self.assertEqual(report['included_designs'], 2)
        self.assertEqual(report['excluded_no_valid_hover'], 3)
        self.assertEqual(report['feasible_designs'], 5)
        self.assertEqual(report['excluded_all_zero_speed_rows'], 97)
        self.assertEqual(report['excluded_nonfinite_speed_rows'], 1)
        self.assertEqual(report['designs_with_unavailable_trim_at_20'], 1)
        self.assertEqual(report['rows'], 4)
        with (self.root / 'dataset_510k.csv').open(newline='', encoding='utf-8') as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual([(int(row['design_id']), int(row['speed'])) for row in rows],
                         [(11, 0), (11, 7), (303, 0), (303, 20)])
        expected_hover = {
            'target_drag': 107, 'target_lift': 106, 'target_thrust': 105,
            'target_pitch': 103, 'target_power': 109, 'target_current': 108,
            'target_flightTime': 102, 'target_distance': 101,
            'dragAt20': 0, 'powerAt20': 0, 'powerAt0': 109,
            'thrustAt0': 105, 'currentAt0': 108,
        }
        for name, expected in expected_hover.items():
            with self.subTest(column=name):
                self.assertEqual(float(rows[0][name]), expected)
        self.assertEqual(float(rows[1]['target_distance']), 201)
        self.assertEqual(float(rows[2]['dragAt20']), 507)
        self.assertEqual(float(rows[2]['powerAt20']), 509)
        with (self.root / 'dl_preprocessor.pkl').open('rb') as handle:
            preprocessor = pickle.load(handle)
        for category, encoder in preprocessor['encoders'].items():
            encoded_value = int(rows[0][f'{category}_enc'])
            self.assertEqual(encoder.inverse_transform([encoded_value])[0], 'Unknown')
        with (self.root / 'dataset_sample.csv').open(newline='', encoding='utf-8') as handle:
            self.assertEqual(list(csv.DictReader(handle)), rows)
        saved_report = json.loads((self.root / 'dataset_summary.json').read_text(encoding='utf-8'))
        self.assertEqual(saved_report['rows'], len(rows))

    def test_duplicate_raw_design_id_is_rejected(self):
        self.write_index([self.design(11)])
        self.write_trims(11, np.ones((51, 12)), part=1)
        self.write_trims(11, np.ones((51, 12)), part=3)
        with self.assertRaisesRegex(ValueError, 'Duplicate raw design ID 11'):
            self.build()

    def test_default_source_and_output_locations_are_independent_of_cwd(self):
        self.write_index([self.design(11)])
        self.write_trims(11, np.ones((51, 12)))
        destination = self.root / 'test-ai-modeling'
        self.assertEqual(dataset.project_dir, SCRIPT_PATH.parent.parent)
        self.assertEqual(dataset.script_dir, SCRIPT_PATH.parent)
        with patch.object(dataset, 'project_dir', self.root), \
                patch.object(dataset, 'script_dir', destination), \
                contextlib.redirect_stdout(io.StringIO()):
            report = dataset.build_dataset()
        self.assertEqual(Path(report['csv_path']), destination / 'dataset_510k.csv')
        for name in ['dataset_510k.csv', 'dl_preprocessor.pkl',
                     'dataset_summary.json', 'dataset_sample.csv']:
            self.assertTrue((destination / name).is_file())
            self.assertFalse((self.root / name).exists())

    def test_explicit_output_directory_is_separate_from_source_root(self):
        self.write_index([self.design(11)])
        self.write_trims(11, np.ones((51, 12)))
        destination = self.root / 'artifacts'
        with contextlib.redirect_stdout(io.StringIO()):
            report = dataset.build_dataset(self.root, output_dir=destination)
        self.assertEqual(Path(report['csv_path']), destination / 'dataset_510k.csv')
        self.assertFalse((self.root / 'dataset_510k.csv').exists())

    def test_mismatched_trim_schema_is_rejected(self):
        self.write_index([self.design(11)], schema=list(reversed(SCHEMA)))
        self.write_trims(11, np.ones((51, 12)))
        with self.assertRaisesRegex(ValueError, 'Unexpected trimSchema'):
            self.build()

    def test_mismatched_trim_shape_identifies_design(self):
        self.write_index([self.design(11)])
        self.write_trims(11, np.ones((51, 13)))
        with self.assertRaisesRegex(ValueError, r'Unexpected trim shape \(51, 13\) for design 11'):
            self.build()


if __name__ == '__main__':
    unittest.main()
