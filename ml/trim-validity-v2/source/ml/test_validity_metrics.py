"""Synthetic tests for masked, disconnected validity-set evaluation."""
import json
import unittest

import numpy as np

from validity_metrics import selection_score, validity_metrics


def sets(rows):
    result = np.zeros((len(rows), 51), dtype=bool)
    for index, speeds in enumerate(rows):
        result[index, speeds] = True
    return result


class ValidityMetricsTests(unittest.TestCase):
    def test_disconnected_sets_and_false_positive_categories(self):
        truth = sets([[0, 2, 4], [1, 3], []])
        predicted = sets([[0, 1, 4, 5], [], [2]])
        result = validity_metrics(truth, predicted.astype(float))
        self.assertEqual((result['tp'], result['fp'], result['fn'], result['tn']), (2, 3, 3, 145))
        self.assertAlmostEqual(result['precision'], 2 / 5)
        self.assertAlmostEqual(result['recall'], 2 / 5)
        self.assertAlmostEqual(result['f1'], 2 / 5)
        self.assertAlmostEqual(result['f0_5'], 2 / 5)
        self.assertAlmostEqual(result['fpr'], 3 / 148)
        self.assertEqual(result['exact_active'], 0)
        self.assertAlmostEqual(result['iou_active'], (2 / 5) / 2)
        self.assertAlmostEqual(result['speed_hamming'], 6 / 153)
        self.assertEqual(result['any_valid_precision'], .5)
        self.assertEqual(result['any_valid_recall'], .5)
        self.assertEqual(result['upper_comparable_designs'], 1)
        self.assertEqual(result['upper_over_fraction'], .5)
        self.assertEqual(result['upper_under_fraction'], .5)
        self.assertEqual(result['missed_active_designs'], 1)
        self.assertEqual(result['dangerous_above_max_cells'], 1)
        self.assertEqual(result['dangerous_hole_cells'], 1)
        self.assertEqual(result['false_positive_inactive_cells'], 1)
        self.assertAlmostEqual(result['mean_true_valid_count'], 5 / 3)
        self.assertAlmostEqual(result['mean_pred_valid_count'], 5 / 3)

    def test_exact_speed_sets_retain_holes(self):
        truth = sets([[1, 3, 5], [], [2]])
        result = validity_metrics(truth, truth.astype(float))
        self.assertEqual(result['exact_all'], 1)
        self.assertEqual(result['exact_active'], 1)
        self.assertEqual(result['iou_active'], 1)
        self.assertEqual(result['upper_over_fraction'], 0)
        self.assertEqual(result['dangerous_hole_cells'], 0)
        self.assertAlmostEqual(selection_score(result), 1)
        filled = sets([[1, 2, 3, 4, 5], [], [2]])
        filled_result = validity_metrics(truth, filled.astype(float))
        self.assertEqual(filled_result['exact_active'], .5)
        self.assertEqual(filled_result['upper_over_fraction'], 0)
        self.assertEqual(filled_result['dangerous_hole_cells'], 2)
        self.assertLess(selection_score(filled_result), selection_score(result))

    def test_masked_hover_is_ignored_in_every_metric(self):
        truth = sets([[0, 2, 4], [0], [0]])
        predicted = sets([[2, 4], [], [50]]).astype(float)
        observed = np.ones_like(truth)
        observed[:, 0] = False
        observed[2] = False
        predicted[0, 0] = np.nan
        predicted[1, 0] = np.inf
        result = validity_metrics(truth, predicted, observed)
        self.assertEqual(result['observed_cells'], 100)
        self.assertEqual(result['observed_designs'], 2)
        self.assertEqual(result['unobserved_designs'], 1)
        self.assertEqual(result['active_designs'], 1)
        self.assertEqual(result['inactive_designs'], 0)
        self.assertEqual(result['complete_observed_designs'], 0)
        self.assertEqual(result['partial_unknown_designs'], 2)
        self.assertEqual(result['partially_observed_active_designs'], 1)
        self.assertEqual(result['any_valid_evaluable_designs'], 1)
        self.assertEqual(result['any_valid_tn'], 0)
        self.assertEqual(result['predicted_active_designs'], 1)
        self.assertEqual(result['exact_all_count'], 0)
        self.assertIsNone(result['exact_all'])
        self.assertEqual(result['observed_exact_all_count'], 2)
        self.assertEqual(result['observed_exact_all'], 1)
        self.assertEqual(result['exact_active'], 1)
        self.assertEqual(result['tp'], 2)
        self.assertEqual(result['fp'], 0)
        self.assertEqual(result['fn'], 0)
        self.assertEqual(result['tn'], 98)
        self.assertEqual(result['upper_equal_count'], 1)
        self.assertEqual(result['mean_true_valid_count'], 1)
        self.assertEqual(result['mean_pred_valid_count'], 1)
        json.dumps(result, allow_nan=False)

    def test_one_negative_and_fifty_unknown_speeds_do_not_establish_inactivity(self):
        truth = sets([[]])
        observed = np.zeros_like(truth)
        observed[:, 50] = True
        probability = np.zeros((1, 51))
        result = validity_metrics(truth, probability, observed)
        self.assertEqual(result['tn'], 1)
        self.assertEqual(result['observed_designs'], 1)
        self.assertEqual(result['complete_observed_designs'], 0)
        self.assertEqual(result['partial_unknown_designs'], 1)
        self.assertEqual(result['inactive_designs'], 0)
        self.assertEqual(result['any_valid_evaluable_designs'], 0)
        self.assertEqual(result['any_valid_tn'], 0)
        self.assertIsNone(result['any_valid_precision'])
        self.assertIsNone(result['exact_all'])
        self.assertEqual(result['observed_exact_all'], 1)
        probability[:, 50] = .9
        false_positive = validity_metrics(truth, probability, observed)
        self.assertEqual(false_positive['fp'], 1)
        self.assertEqual(false_positive['any_valid_fp'], 0)
        self.assertEqual(false_positive['false_positive_inactive_cells'], 0)
        self.assertEqual(false_positive['false_positive_unknown_activity_cells'], 1)
        self.assertEqual(false_positive['observed_exact_all'], 0)

    def test_all_negative_collapse_cannot_win_on_empty_designs(self):
        truth = sets([[1, 4]] + [[] for _ in range(99)])
        collapsed = validity_metrics(truth, np.zeros_like(truth, dtype=float))
        self.assertEqual(collapsed['exact_all'], .99)
        self.assertEqual(collapsed['exact_active'], 0)
        self.assertEqual(collapsed['iou_active'], 0)
        self.assertEqual(collapsed['upper_over_fraction'], 0)
        self.assertEqual(collapsed['upper_under_fraction'], 1)
        self.assertEqual(collapsed['recall'], 0)
        self.assertLess(selection_score(collapsed), -1)
        sensible = validity_metrics(truth, truth.astype(float))
        self.assertGreater(selection_score(sensible), selection_score(collapsed))

    def test_no_labels_or_no_positive_labels_are_not_selection_evidence(self):
        for truth, mask in [(sets([]), None), (sets([[], []]), None),
                            (sets([[1]]), np.zeros((1, 51), dtype=bool))]:
            result = validity_metrics(truth, np.zeros_like(truth, dtype=float), mask)
            self.assertIsNone(result['recall'])
            self.assertIsNone(result['exact_active'])
            self.assertIsNone(result['iou_active'])
            self.assertIsNone(result['upper_over_fraction'])
            self.assertEqual(selection_score(result), -2)
            json.dumps(result, allow_nan=False)

    def test_false_positive_partition_and_threshold_boundary(self):
        truth = sets([[2, 4], []])
        probability = np.zeros((2, 51))
        probability[0, [0, 2, 3, 4, 5]] = .5
        probability[1, [1, 2]] = .7
        result = validity_metrics(truth, probability, threshold=.5)
        categories = ['dangerous_above_max_cells', 'dangerous_hole_cells',
                      'false_positive_below_min_cells', 'false_positive_inactive_cells']
        self.assertEqual(sum(result[key] for key in categories), result['fp'])
        self.assertEqual(result['fp'], 5)
        self.assertEqual(result['f0_5'], 2.5 / 7.5)
        self.assertEqual(result['upper_over_fraction'], 1)
        self.assertEqual(result['recall'], 1)
        changed = validity_metrics(truth, probability, threshold=.6)
        self.assertEqual(changed['tp'], 0)
        self.assertEqual(changed['upper_over_fraction'], 0)
        self.assertEqual(changed['upper_under_fraction'], 1)

    def test_invalid_inputs_are_rejected(self):
        truth = sets([[1]])
        with self.assertRaisesRegex(ValueError, 'shape'):
            validity_metrics(np.zeros((1, 50)), np.zeros((1, 50)))
        with self.assertRaisesRegex(ValueError, 'shape'):
            validity_metrics(truth, np.zeros((2, 51)))
        with self.assertRaisesRegex(ValueError, 'observed_mask'):
            validity_metrics(truth, truth, np.ones((2, 51)))
        with self.assertRaisesRegex(ValueError, 'threshold'):
            validity_metrics(truth, truth, threshold=np.nan)
        for value in [-.1, 1.1, np.inf, np.nan]:
            probability = truth.astype(float)
            probability[0, 0] = value
            with self.assertRaisesRegex(ValueError, 'probabilities'):
                validity_metrics(truth, probability)
        malformed = truth.astype(float)
        malformed[0, 0] = 2
        with self.assertRaisesRegex(ValueError, 'truth values'):
            validity_metrics(malformed, truth)
        with self.assertRaisesRegex(ValueError, 'Recall guards'):
            selection_score(validity_metrics(truth, truth), minimum_recall=0)


if __name__ == '__main__':
    unittest.main()
