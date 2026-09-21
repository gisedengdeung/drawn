"""Convert trusted training artifacts into a pickle-free, numerically checked bundle.

Export with numpy, pandas and scikit-learn 1.6.1 installed. --torch-python may
name a separate Python containing PyTorch. --verify-only needs just the existing
backend runtime environment and never loads pickle or writes bundle files. The model must reproduce supplied GPU
reference predictions before CPU-specific golden vectors can be generated.
This script never trains, fits preprocessing, or changes source artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import io
import json
import pickle
from pathlib import Path
import subprocess
import sys

ALLOWED = {
    ("sklearn.compose._column_transformer", "ColumnTransformer"),
    ("sklearn.compose._column_transformer", "_RemainderColsList"),
    ("sklearn.preprocessing._data", "StandardScaler"),
    ("sklearn.preprocessing._encoders", "OneHotEncoder"),
    ("sklearn.preprocessing._label", "LabelEncoder"),
    ("numpy", "float64"), ("numpy", "ndarray"), ("numpy", "dtype"),
    ("numpy._core.multiarray", "_reconstruct"), ("numpy._core.multiarray", "scalar"),
    ("builtins", "slice"),
}


class RestrictedPreprocessor(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) not in ALLOWED:
            raise pickle.UnpicklingError(f"Unapproved preprocessor type: {module}.{name}")
        return getattr(importlib.import_module(module), name)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


TORCH_RUNNER = r'''
import json,sys,torch,numpy as np
request=json.load(sys.stdin)
checkpoint=torch.load(request['checkpoint'],map_location='cpu',weights_only=True)
if (checkpoint['input_dim']!=274 or checkpoint['hidden']!=[256,256,128]
    or checkpoint['dropout']!=0.05): raise ValueError('Unexpected checkpoint architecture')
layers=[]
for left,right in zip((274,256,256),(256,256,128)):
    layers.extend([torch.nn.Linear(left,right),torch.nn.SiLU(),torch.nn.Dropout(.05)])
layers.append(torch.nn.Linear(128,8))
model=torch.nn.Sequential(*layers);model.load_state_dict(checkpoint['state_dict'],strict=True);model.eval()
np.savez(request['weights'],**{key:value.cpu().numpy() for key,value in checkpoint['state_dict'].items()})
matrix=torch.tensor(request['matrix'],dtype=torch.float32)
result={'torch':torch.__version__,'cudaAvailable':torch.cuda.is_available(),'predictions':{}}
with torch.inference_mode():
    torch.set_float32_matmul_precision('highest')
    result['predictions']['cpu-highest']=model(matrix).tolist()
    if torch.cuda.is_available():
        result['gpu']=torch.cuda.get_device_name(0)
        model=model.to('cuda');matrix=matrix.to('cuda')
        for precision in ('highest','high','medium'):
            torch.set_float32_matmul_precision(precision)
            result['predictions']['cuda-'+precision]=model(matrix).cpu().tolist()
print(json.dumps(result))
'''


VERIFY_RUNNER = r'''
import json,sys
from pathlib import Path
from backend.app.performance import Runtime
request=json.load(sys.stdin)
runtime=Runtime(Path(request["bundle"]))
print(json.dumps({"modelVersion":runtime.version,"verification":runtime.verify()}))
'''


def verify_existing_bundle(run, dataset, output, torch_python, root):
    """Check source provenance and actual CPU inference without unpickling or writing."""
    manifest = json.loads((output / "manifest.json").read_text("utf-8"))
    config = json.loads((run / "config.json").read_text("utf-8"))
    for name in ("best_model.pt", "model_preprocessor.pkl", "config.json"):
        if sha(run / name) != manifest["sourceFiles"][name]:
            raise ValueError(f"Source checksum mismatch: {name}")
    if sha(dataset) != config["dataset_sha256"] or config["dataset_sha256"] != manifest["datasetSha256"]:
        raise ValueError("Dataset checksum mismatch")
    process = subprocess.run(
        [torch_python, "-c", VERIFY_RUNNER],
        input=json.dumps({"bundle": str(output)}), cwd=root,
        text=True, capture_output=True, check=True, timeout=180,
    )
    result = json.loads(process.stdout)
    print(json.dumps({"verified": result["verification"]["passed"],
                      "sourceRun": str(run), "dataset": str(dataset),
                      "bundle": str(output), **result}))
    return 0 if result["verification"]["passed"] else 2


def main():
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, default=root / "ml/sources/dongha/20260920_160522")
    parser.add_argument("--dataset", type=Path, default=root / "ml/sources/dongha/dataset_510k.csv")
    parser.add_argument("--output", type=Path, default=root / "backend/model_bundle")
    parser.add_argument("--torch-python", default=sys.executable)
    parser.add_argument("--verify-only", action="store_true",
                        help="Verify source hashes and the existing CPU bundle without exporting or loading pickle")
    args = parser.parse_args()
    run, output = args.run.resolve(), args.output.resolve()
    if args.verify_only:
        return verify_existing_bundle(run, args.dataset.resolve(), output, args.torch_python, root)
    import numpy as np
    import pandas as pd

    config = json.loads((run / "config.json").read_text("utf-8"))
    if sha(args.dataset) != config["dataset_sha256"]:
        raise ValueError("Dataset differs from the trained run; do not use v2")
    source = RestrictedPreprocessor(io.BytesIO((run / "model_preprocessor.pkl").read_bytes())).load()
    transformer, scaler = source["input_transformer"], source["target_scaler"]
    numeric, categorical = transformer.named_transformers_["numeric"], transformer.named_transformers_["categorical"]
    preprocessing = {
        "feature_columns": source["feature_columns"], "target_columns": source["target_columns"],
        "numeric_columns": transformer.transformers_[0][2],
        "numeric_mean": numeric.mean_.tolist(), "numeric_scale": numeric.scale_.tolist(),
        "onehot_categories": [values.tolist() for values in categorical.categories_],
        "category_classes": {key: encoder.classes_.tolist() for key, encoder in source["category_encoders"].items()},
        "numeric_training_bounds": source["numeric_training_bounds"],
        "target_mean": scaler.mean_.tolist(), "target_scale": scaler.scale_.tolist(),
        "derived_features": {"trim20_available": "finite(powerAt20) and powerAt20 > 0"},
        "unknown_category": "all_zero_one_hot_block",
    }
    if categorical.handle_unknown != "ignore" or categorical.drop is not None:
        raise ValueError("Unexpected categorical preprocessing")
    inputs = pd.read_csv(run / "inference_input_sample.csv")[source["feature_columns"]]
    frame = inputs.copy()
    frame["trim20_available"] = (np.isfinite(frame.powerAt20) & (frame.powerAt20 > 0)).astype(float)
    matrix = transformer.transform(frame).astype(np.float32)
    if matrix.shape != (len(inputs), 274):
        raise ValueError("Unexpected transformed input width")
    expected = pd.read_csv(run / "inference_output_sample.csv")
    expected = expected[[name.replace("target_", "predicted_") for name in source["target_columns"]]].to_numpy()
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "preprocessing.json", preprocessing)
    process = subprocess.run(
        [args.torch_python, "-c", TORCH_RUNNER],
        input=json.dumps({"checkpoint": str(run / "best_model.pt"), "weights": str(output / "weights.npz"),
                          "matrix": matrix.tolist()}),
        text=True, capture_output=True, check=True, timeout=180,
    )
    execution = json.loads(process.stdout)
    results, physical = {}, {}
    for name, scaled in execution.pop("predictions").items():
        values = scaler.inverse_transform(np.asarray(scaled, dtype=np.float32))
        physical[name] = values
        difference = np.abs(values - expected)
        results[name] = {"passed": bool(np.allclose(values, expected, rtol=2e-6, atol=1e-4)),
                         "maxAbsoluteByTarget": difference.max(axis=0).tolist(),
                         "maxTargetScaledError": float((difference / scaler.scale_).max())}
    matching = [name for name, result in results.items() if result["passed"]]
    verified = bool(matching)
    # CPU fixtures are only promoted after an actual runtime reproduces the original reference.
    golden = {"inputs": inputs.to_dict("records"),
              "expected": (physical["cpu-highest"] if verified else expected).tolist(),
              "originalExpected": expected.tolist(), "originalReferenceMatchedBy": matching,
              "runtime": "cpu-highest" if verified else "unverified-original-reference"}
    write_json(output / "golden.json", golden)
    splits = json.loads((run / "split_design_ids.json").read_text("utf-8"))
    manifest = {
        "schemaVersion": 1, "modelVersion": "best-mlp-20260920-" + sha(run / "best_model.pt")[:12],
        "architecture": [274, 256, 256, 128, 8], "activation": "silu", "dropout": .05,
        "architectureVerified": verified, "source": "baseline-conditioned",
        "sourceFiles": {name: sha(run / name) for name in ("best_model.pt", "model_preprocessor.pkl", "config.json")},
        "datasetSha256": config["dataset_sha256"],
        "eligibleDesignIds": sorted({int(value) for values in splits.values() for value in values}),
        "verification": {"rows": len(inputs), "rtol": 2e-6, "atol": 1e-4, "runtime": execution,
                         "results": results, "matchingOriginalReference": matching},
        "files": {name: {"sha256": sha(output / name), "bytes": (output / name).stat().st_size}
                  for name in ("preprocessing.json", "weights.npz", "golden.json")},
    }
    write_json(output / "manifest.json", manifest)
    print(json.dumps({"verified": verified, "matchingOriginalReference": matching, "results": results,
                      "bundle": str(output), "bytes": sum(p.stat().st_size for p in output.iterdir() if p.is_file())}))
    return 0 if verified else 2


if __name__ == "__main__":
    raise SystemExit(main())
