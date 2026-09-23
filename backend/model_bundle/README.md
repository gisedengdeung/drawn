# Conditional trim MLP

This package serves `ml/sources/dongha/20260920_160522` without loading pickle files at runtime.
`weights.npz` contains only numeric tensors; `preprocessing.json` contains the fitted
numeric scales, exact one-hot categories, target inverse transform and training bounds.
`manifest.json` records source hashes and verification. The source dataset hash matches
`ml/sources/dongha/dataset_510k.csv`, not `ml/sources/dongha/v2/dataset_510k.csv`.

FastAPI reconstructs the PyTorch network and runs CPU inference using these tensors.
`weights.npz` is a lossless numeric export of the trained checkpoint, not a separate
model or a simulated prediction. Source `.pt` and `.pkl` copies formerly at the repository
root are preserved under `ml/archive/root-artifacts`; the runtime does not use them.
See [the ML inventory](../../ml/README.md) for source ownership, hashes and retained
PointNet experiments.

The checkpoint uses Linear → SiLU → Dropout blocks (274 → 256 → 256 → 128 → 8).
Inference disables dropout. The supplied original predictions are reproduced by
PyTorch 2.13.0 + CUDA 13.0 with `float32_matmul_precision='high'` on RTX 5070 Ti.
They use reduced-precision CUDA matrix multiplication. CPU `highest` differs slightly;
the original-reference validation is retained, and CPU-specific golden vectors are
generated only after the original reference passes `rtol=2e-6, atol=1e-4`.

Startup checks all packaged hashes and CPU golden vectors. A missing, incompatible or
unverified package disables model inference instead of returning fabricated predictions.

The eight outputs are drag/lift/thrust (N), pitch (deg), power (W), current (A),
flightTime (s) and distance (m). The model conditions on existing hover and optional
20 m/s simulation anchors; it does not predict mass, flight feasibility or maximum speed.
Training speed bounds are 0–49 m/s; 50 m/s is explicitly reported as extrapolation.
Unknown categories use the fitted all-zero one-hot policy. Invalid negative outputs
are returned as unavailable, not silently clamped to zero.

To rebuild, use the repository's `scripts/package-performance-model.py` with the trusted
run artifacts and a CUDA-capable PyTorch interpreter. It verifies source dataset hashes,
uses an allowlisted preprocessor loader and `torch.load(weights_only=True)`, then exports
only the minimal inference artifacts. No training or preprocessor refitting occurs.

To verify the moved source files and the existing runtime bundle without exporting or
loading pickle, run from the repository root:

```powershell
backend/.venv/Scripts/python.exe scripts/package-performance-model.py --verify-only
```

This checks source/dataset hashes and executes the 20 CPU golden predictions. The
running service exposes the same runtime validation at `GET /api/performance/model`;
actual design predictions are served by `POST /api/performance/predict`. The source
run's old absolute path strings remain untouched as historical metadata. Packaging
uses its current default paths or explicit `--run`, `--dataset` and `--output` options.
