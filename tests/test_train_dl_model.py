"""Tests for design-level holdout isolation and persisted training artifacts."""

import argparse
import contextlib
import io
import json
from pathlib import Path
import pickle
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
import torch
from sklearn.preprocessing import LabelEncoder

MODELING_DIR = Path(__file__).resolve().parents[1] / 'test-ai-modeling'
sys.path.insert(0, str(MODELING_DIR))
import train_dl_model as training


class TrainingRegressionTests(unittest.TestCase):
    def make_frame(self):
        rows = []
        for design_id in range(100, 120):
            for speed in (0, 7, 11, 20):
                row = {'design_id': design_id}
                for index, feature in enumerate(training.FEATURE_COLUMNS):
                    row[feature] = design_id % 2 if feature in training.CATEGORY_COLUMNS else design_id * 10 + speed + index
                row['speed'] = speed
                for index, target in enumerate(training.TARGET_COLUMNS):
                    row[target] = design_id * 3 + speed * (index + 1)
                rows.append(row)
        return pd.DataFrame(rows)

    def test_design_splits_are_disjoint_complete_and_reproducible(self):
        frame = self.make_frame()
        groups, masks = training.split_designs(frame, seed=42)
        names = ('train', 'validation', 'test')
        for position, name in enumerate(names):
            for other in names[position + 1:]:
                self.assertFalse(set(groups[name]) & set(groups[other]))
            self.assertEqual(set(frame.loc[masks[name], 'design_id']), set(groups[name]))
            self.assertTrue((frame.loc[masks[name]].groupby('design_id').size() == 4).all())
        self.assertEqual(set().union(*(set(groups[name]) for name in names)), set(frame.design_id))
        np.testing.assert_array_equal(sum(mask.astype(int) for mask in masks.values()), np.ones(len(frame)))
        same_groups, _ = training.split_designs(frame.sample(frac=1, random_state=9), seed=42)
        for name in names:
            np.testing.assert_array_equal(same_groups[name], groups[name])
        changed_groups, _ = training.split_designs(frame, seed=43)
        self.assertFalse(np.array_equal(groups['test'], changed_groups['test']))

    def test_tiny_training_fits_train_only_and_reloads_checkpoint(self):
        frame = self.make_frame()
        groups, masks = training.split_designs(frame, seed=42)
        held_out = ~masks['train']
        # Make held-out values visibly different from training statistics.
        numeric = [column for column in training.FEATURE_COLUMNS
                   if column not in training.CATEGORY_COLUMNS and column != 'speed']
        frame.loc[held_out, numeric] += 10000
        frame.loc[held_out, training.TARGET_COLUMNS] += 10000
        frame.loc[held_out, training.CATEGORY_COLUMNS] = 2

        with tempfile.TemporaryDirectory(prefix='aircraftverse-training-test-') as directory:
            root = Path(directory)
            csv_path = root / 'dataset_510k.csv'
            frame.to_csv(csv_path, index=False)
            encoders = {
                name.removesuffix('_enc'): LabelEncoder().fit(['component-A', 'component-B', 'unseen-component'])
                for name in training.CATEGORY_COLUMNS
            }
            with (root / 'dl_preprocessor.pkl').open('wb') as handle:
                pickle.dump({'encoders': encoders}, handle)
            run_dir = root / 'tiny-run'
            args = argparse.Namespace(
                seed=42, device='cpu', csv=str(csv_path), output_dir=str(run_dir),
                hidden=[8, 6], dropout=0.2, lr=0.001, epochs=1, patience=1, batch_size=16,
            )
            with patch.object(training, 'HERE', root), contextlib.redirect_stdout(io.StringIO()):
                report = training.train(args)
            self.assertEqual(report['epochs_completed'], 1)
            saved_groups = json.loads((run_dir / 'split_design_ids.json').read_text(encoding='utf-8'))
            for name, ids in groups.items():
                self.assertEqual(saved_groups[name], ids.tolist())

            with (run_dir / 'model_preprocessor.pkl').open('rb') as handle:
                preprocessing = pickle.load(handle)
            x_transformer = preprocessing['input_transformer']
            target_scaler = preprocessing['target_scaler']
            np.testing.assert_allclose(target_scaler.mean_, frame.loc[masks['train'], training.TARGET_COLUMNS].mean())
            self.assertFalse(np.allclose(target_scaler.mean_, frame[training.TARGET_COLUMNS].mean()))
            features = training.feature_frame(frame)
            trained_numeric = x_transformer.transformers_[0][2]
            np.testing.assert_allclose(
                x_transformer.named_transformers_['numeric'].mean_,
                features.loc[masks['train'], trained_numeric].mean(),
            )
            onehot = x_transformer.named_transformers_['categorical']
            for values in onehot.categories_:
                np.testing.assert_array_equal(values, [0, 1])
            unknown = onehot.transform(features.loc[held_out, training.CATEGORY_COLUMNS])
            self.assertTrue(np.all(unknown == 0))
            self.assertEqual(set(preprocessing['category_encoders']), set(encoders))

            # Reconstruct using only persisted architecture, weights and transforms.
            checkpoint = torch.load(run_dir / 'best_model.pt', map_location='cpu', weights_only=True)
            reloaded = training.make_model(checkpoint['input_dim'], checkpoint['hidden'], checkpoint['dropout'])
            reloaded.load_state_dict(checkpoint['state_dict'])
            inputs = torch.tensor(x_transformer.transform(features.loc[masks['test']]).astype(np.float32))
            scaled = training.predict_scaled(reloaded, inputs, batch_size=3).numpy()
            predictions = target_scaler.inverse_transform(scaled)
            saved_predictions = pd.read_csv(run_dir / 'test_predictions.csv')
            predicted_columns = [target.replace('target_', 'predicted_') for target in training.TARGET_COLUMNS]
            np.testing.assert_allclose(predictions, saved_predictions[predicted_columns].to_numpy(), rtol=2e-6, atol=1e-4)
            np.testing.assert_array_equal(saved_predictions.design_id, frame.loc[masks['test'], 'design_id'])
            # Inference must disable dropout even if the caller puts the model into train mode.
            reloaded.train()
            again = training.predict_scaled(reloaded, inputs, batch_size=3).numpy()
            np.testing.assert_array_equal(scaled, again)


if __name__ == '__main__':
    unittest.main()
