"""Stage 3 — train the PointNet regressor.

Scoring convention, fixed to match ml/geometry_baseline.py so the numbers are
comparable: R2 is computed in the raw target unit, against the *training* mean
as the reference. Nothing here ever touches the test split; model selection is
on val, and test belongs to stage 4.

The loss is Huber on standardised targets. The targets are heavily tailed
(Max_Distance runs from a 1,677 m median to 40,905 m), but log-transforming
them loses on every target once scored back in the raw unit — see the baseline
report. Robustness belongs in the loss, not in a transform of the target.

Usage:
    ml\\.venv\\Scripts\\python.exe ml\\train.py --targets span            # rung 1a
    ml\\.venv\\Scripts\\python.exe ml\\train.py --targets aspect_zx       # rung 1b
    ml\\.venv\\Scripts\\python.exe ml\\train.py --targets Mass            # rung 2
    ml\\.venv\\Scripts\\python.exe ml\\train.py --targets Mass,Max_Distance
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from common import REPO_ROOT, write_json
from dataset import DEFAULT_DATA, load_bundle
from model import PointNetRegressor, count_parameters

BASELINE_REPORT = REPO_ROOT / "ml" / "reports" / "geometry_baseline.json"


def load_baselines() -> dict:
    if not BASELINE_REPORT.is_file():
        return {}
    report = json.loads(BASELINE_REPORT.read_text(encoding="utf-8"))
    return report.get("targets", {})


def evaluate(model, bundle, split: str, batch_size: int) -> dict:
    """R2 and MAE per target, in raw units, referenced to the training mean."""
    model.eval()
    predictions = []
    order = []
    with torch.no_grad():
        for index in bundle.sequential(split, batch_size):
            output = model(bundle.points[index], bundle.scale_feature[index])
            predictions.append(output.float().cpu().numpy())
            order.append(index.cpu().numpy())
    model.train()

    predicted = np.concatenate(predictions) * bundle.std + bundle.mean
    rows = np.concatenate(order)
    actual = bundle.raw_targets[rows]

    results = {}
    for column, name in enumerate(bundle.target_names):
        usable = np.isfinite(actual[:, column])
        if not usable.any():
            continue
        truth = actual[usable, column]
        guess = predicted[usable, column]
        residual = ((truth - guess) ** 2).sum()
        total = ((truth - bundle.mean[column]) ** 2).sum()
        results[name] = {
            "n": int(usable.sum()),
            "r2": float(1 - residual / total),
            "mae": float(np.abs(truth - guess).mean()),
            "rmse": float(np.sqrt(((truth - guess) ** 2).mean())),
        }
    return results


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Stage 3 PointNet training")
    parser.add_argument("--targets", default="Mass", help="comma separated target names")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--dropout", type=float, default=0.3)
    parser.add_argument("--pool", default="max", choices=["max", "mean", "maxmean"],
                        help="global pooling; max reads the bounding box, "
                             "mean carries interior distribution")
    parser.add_argument("--jitter", type=float, default=0.01,
                        help="gaussian noise sigma in normalised units, 0 disables")
    parser.add_argument("--huber-delta", type=float, default=1.0)
    parser.add_argument("--no-scale", action="store_true",
                        help="ablation: withhold the scale input")
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--tag", default=None, help="run name; defaults to the target list")
    parser.add_argument("--runs", type=Path, default=REPO_ROOT / "ml" / "runs")
    args = parser.parse_args(argv)

    target_names = [name.strip() for name in args.targets.split(",") if name.strip()]
    tag = args.tag or "_".join(target_names) + ("_noscale" if args.no_scale else "")

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    bundle = load_bundle(target_names, path=args.data, device=args.device)
    rungs = sorted(set(bundle.rungs))
    baselines = load_baselines()

    model = PointNetRegressor(
        n_targets=len(target_names),
        use_scale=not args.no_scale,
        dropout=args.dropout,
        pool=args.pool,
    ).to(args.device)
    optimiser = torch.optim.AdamW(
        model.parameters(), lr=args.lr, weight_decay=args.weight_decay
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimiser, T_max=args.epochs)
    criterion = nn.HuberLoss(delta=args.huber_delta, reduction="none")

    n_train = len(bundle.indices["train"])
    print(f"run          : {tag}")
    print(f"targets      : {target_names}  (ladder {rungs})")
    print(f"scale input  : {'OFF (ablation)' if args.no_scale else 'ON'}")
    print(f"device       : {args.device}")
    print(f"designs      : train {n_train}  val {len(bundle.indices['val'])}")
    print(f"parameters   : {count_parameters(model):,}")
    for name in target_names:
        entry = baselines.get(name, {}).get("val", {})
        floor = entry.get("mesh", {}).get("r2")
        stretch = entry.get("mesh+cad", {}).get("r2")
        if floor is not None:
            print(f"  val floor  {name:<22} mesh R2 = {floor:.3f}"
                  f"   (mesh+cad reference {stretch:.3f})")
    print()

    generator = torch.Generator(device=args.device).manual_seed(args.seed)
    best = {"score": -float("inf"), "epoch": -1, "val": None, "state": None}
    history = []
    started = time.time()

    for epoch in range(1, args.epochs + 1):
        total_loss = 0.0
        n_batches = 0
        for index in bundle.batches("train", args.batch_size, generator=generator):
            points = bundle.points[index]
            if args.jitter > 0:
                points = points + torch.randn_like(points) * args.jitter

            output = model(points, bundle.scale_feature[index])
            mask = bundle.mask[index]
            per_element = criterion(output, bundle.targets[index]) * mask
            denominator = mask.sum()
            if denominator == 0:
                continue
            loss = per_element.sum() / denominator

            optimiser.zero_grad(set_to_none=True)
            loss.backward()
            optimiser.step()
            total_loss += float(loss.detach())
            n_batches += 1
        scheduler.step()

        val = evaluate(model, bundle, "val", args.batch_size)
        score = float(np.mean([entry["r2"] for entry in val.values()]))
        history.append(
            {"epoch": epoch, "train_loss": total_loss / max(n_batches, 1), "val": val}
        )

        marker = ""
        if score > best["score"]:
            best = {
                "score": score,
                "epoch": epoch,
                "val": val,
                "state": {k: v.detach().cpu().clone() for k, v in model.state_dict().items()},
            }
            marker = "  *"

        summary = "  ".join(
            f"{name} R2 {entry['r2']:.4f}" for name, entry in val.items()
        )
        print(f"  epoch {epoch:>3}/{args.epochs}  loss {total_loss / max(n_batches, 1):.4f}  "
              f"{summary}{marker}", flush=True)

        if epoch - best["epoch"] >= args.patience:
            print(f"  early stop: no val improvement for {args.patience} epochs")
            break

    elapsed = time.time() - started
    args.runs.mkdir(parents=True, exist_ok=True)
    checkpoint = args.runs / f"{tag}.pt"
    torch.save(
        {
            "state_dict": best["state"],
            "target_names": target_names,
            "target_mean": bundle.mean,
            "target_std": bundle.std,
            # Without these the checkpoint cannot be used for inference
            # unless the whole 333 MB training set is at hand.
            "scale_log_mean": bundle.scale_log_mean,
            "scale_log_std": bundle.scale_log_std,
            "use_scale": not args.no_scale,
            "dropout": args.dropout,
            "pool": args.pool,
            "epoch": best["epoch"],
            "val": best["val"],
        },
        checkpoint,
    )

    result = {
        "tag": tag,
        "targets": target_names,
        "ladder_rungs": bundle.rungs,
        "scale_input": not args.no_scale,
        "best_epoch": best["epoch"],
        "epochs_run": len(history),
        "elapsed_minutes": round(elapsed / 60, 2),
        "val": best["val"],
        "val_geometry_baseline": {
            name: baselines.get(name, {}).get("val", {}).get("mesh", {}).get("r2")
            for name in target_names
        },
        "val_mesh_cad_reference": {
            name: baselines.get(name, {}).get("val", {}).get("mesh+cad", {}).get("r2")
            for name in target_names
        },
        "args": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
        "checkpoint": str(checkpoint),
        "history": history,
    }
    report_path = args.runs / f"{tag}.json"
    write_json(report_path, result)

    print()
    print("=" * 74)
    print(f"best epoch {best['epoch']}  ({elapsed / 60:.1f} min)")
    print(f"  {'target':<24}{'val R2':>10}{'mesh floor':>12}{'delta':>10}"
          f"{'mesh+cad':>11}{'val MAE':>12}")
    for name, entry in best["val"].items():
        floor = result["val_geometry_baseline"].get(name)
        stretch = result["val_mesh_cad_reference"].get(name)
        delta = f"{entry['r2'] - floor:+.4f}" if floor is not None else "—"
        floor_text = f"{floor:.4f}" if floor is not None else "—"
        stretch_text = f"{stretch:.4f}" if stretch is not None else "—"
        print(f"  {name:<24}{entry['r2']:>10.4f}{floor_text:>12}{delta:>10}"
              f"{stretch_text:>11}{entry['mae']:>12.4f}")
    print("=" * 74)
    print(f"checkpoint -> {checkpoint}")
    print(f"result     -> {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
