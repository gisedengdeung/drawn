# Trim validity retraining

Source baseline: git commit `745f00c`, checkpoint `ml/runs/trim_pointnet_v1.pt`.
The current feature/agent checkout is left intact; the ML source snapshot and
all retraining artifacts live in this output directory.

## Prior findings supplied by the recipient

- Six regression tasks are useful. Preserve that behavior while retraining validity.
- Test validity exact active speed-set match: 38/879 (4.3%); approximately 41%
  overestimate the upper valid speed. A continuous interval cannot represent
  fragmented support. Threshold-only optimization was already exhausted.
- Predicted-Mass anchoring was tried and rejected: thrust MAE 3.22 -> 6.52 N;
  true-Mass anchoring achieved 1.25 N. Do not repeat predicted-Mass anchoring.
- Design 20015 has a suspect hover row: Mass 7.37 kg, thrust 19.27 N,
  missing drag, and maxUc exactly 0.5. It belongs to test. Its label must not
  be used to choose model hyperparameters, and exclusion is not a negative label.

## Fixed experiment policy (before new test evaluation)

1. Preserve family-based train/validation/test assignments and dataset hashes.
2. Audit the raw-data hover signature and create an independent observation mask.
   Original labels and NPZ files remain unchanged. Report legacy and masked metrics.
3. Keep the PointNet encoder and six regression outputs fixed for the main
   classifier comparison. Train a separate 51-output MLP on its frozen geometry
   features. This allows disjoint valid-speed sets without changing good regression.
4. Compare unweighted BCE, square-root positive weighting, and FP-weighted
   per-design Tversky/set loss plus an upper-speed false-positive penalty.
   The original model already used negative/positive BCE weighting and lambda=.25.
   Increasing that positive weight blindly may increase dangerous false positives.
5. Choose checkpoints and a probability threshold on validation only. Require
   recall >= max(0.60, baseline validation recall - 0.10), plus any-valid design
   recall >= 0.70. Rank eligible models using active-design set overlap, exact
   speed-set match, F0.5, and upper-bound overestimation. Also report F1 and recall.
6. Optionally refine only the regression MLP using clean target cells and a weak
   training-only hover thrust=Mass*g regularizer, using true dataset Mass. Accept
   only if each validation R2 loses at most .005 and macro R2 improves. Otherwise
   preserve all six original regressors. This is a separate validation decision.
7. Freeze choices, evaluate held-out test once, and export ONNX with the existing
   encoder/head contract. Explicitly report if validity remains inadequate for UI.

The existing test set has already informed the problem statement, so this is
not a pristine never-inspected holdout. No new test scores drive model selection.

## Validation-driven second stage (before any new test evaluation)

Frozen-feature set loss reduced validation upper-overestimation but did not
substantially improve full speed-set matches. Two further experiments fine-tune
a separate validity PointNet encoder while preserving the original regression
encoder and outputs. Both start from the chosen frozen-feature classifier, with
BCE positive weights 1 or sqrt(train negative/positive), set weight .5 and
upper-FP weight .25. Encoder/head learning rates are 2e-5/2e-4; at most60 epochs
with18-epoch patience, batch128, bf16 training and FP32 validation, jitter .003.
The original validation objective and recall guards remain fixed. Select among
phase1 and phase2 using validation only. The combined encoder caches two feature
blocks (4098 floats rather than2049); load the matched new encoder/head pair.
