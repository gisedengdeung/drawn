"""Train a PointNet trim model using family-fixed train/val splits only."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from contextlib import nullcontext
from pathlib import Path

import numpy as np
import torch
from torch import nn

from common import REPO_ROOT, write_json
from dataset_trim import (DEFAULT_POINTS, DEFAULT_TRIMS, load_trim_bundle,
                          inverse_targets, normalization_dict)
from model_trim import TrimPointNet, TARGET_NAMES


def masked_regression_loss(predicted, target, mask, loss='huber'):
    if loss == 'huber':
        values = nn.functional.huber_loss(predicted, target, reduction='none', delta=1.0)
    else:
        values = (predicted - target).square()
    counts = mask.sum(dim=(0, 1))
    sums = (values * mask).sum(dim=(0, 1))
    # Keep the six tasks equally weighted when a column (e.g. drag) has NaNs.
    usable = counts > 0
    return (sums / counts.clamp_min(1) * usable).sum() / usable.sum().clamp_min(1)


def deciles(truth, predicted):
    finite = np.isfinite(truth) & np.isfinite(predicted)
    truth, predicted = truth[finite], predicted[finite]
    if len(truth) == 0:
        return []
    order = np.argsort(truth, kind='stable')
    result = []
    for rows in np.array_split(order, 10):
        if len(rows) == 0:
            continue
        actual_median = float(np.median(truth[rows]))
        result.append({
            'n': len(rows), 'actual_median': actual_median,
            'predicted_median': float(np.median(predicted[rows])),
            'ratio_of_medians': float(np.median(predicted[rows]) / actual_median)
            if abs(actual_median) > 1e-8 else None,
        })
    return result


@torch.inference_mode()
def validate(model, bundle, batch_size, amp=False, shrinkage=False):
    model.eval()
    regression, logits, indices = [], [], []
    for index in bundle.sequential('val', batch_size):
        context = torch.autocast('cuda', dtype=torch.bfloat16) if amp else nullcontext()
        with context:
            predicted, valid_logits = model(bundle.points[index], bundle.scale_feature[index])
        regression.append(predicted.float().cpu().numpy())
        logits.append(valid_logits.float().cpu().numpy())
        indices.append(index.cpu().numpy())
    rows = np.concatenate(indices)
    prediction = inverse_targets(np.concatenate(regression), bundle)
    truth = bundle.raw_targets[rows]
    z = np.concatenate(logits)
    probability = 1 / (1 + np.exp(-np.clip(z, -80, 80)))
    actual_valid = bundle.valid[torch.as_tensor(rows, device=bundle.valid.device)].cpu().numpy().astype(bool)
    predicted_valid = probability >= 0.5
    tp = int((actual_valid & predicted_valid).sum())
    fp = int((~actual_valid & predicted_valid).sum())
    fn = int((actual_valid & ~predicted_valid).sum())
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * tp / max(2 * tp + fp + fn, 1)
    metrics, tail = {}, {}
    for col, name in enumerate(bundle.target_names):
        usable = np.isfinite(truth[:, :, col])
        actual, pred = truth[:, :, col][usable], prediction[:, :, col][usable]
        sse = float(np.square(actual - pred).sum())
        denominator = float(np.square(actual - bundle.raw_mean[col]).sum())
        metrics[name] = {
            'n': int(usable.sum()), 'r2': 1 - sse / max(denominator, 1e-12),
            'mae': float(np.abs(actual - pred).mean()),
            'rmse': float(np.sqrt(np.mean(np.square(actual - pred)))),
        }
        if shrinkage:
            tail[name] = deciles(actual, pred)
    macro_r2 = float(np.mean([item['r2'] for item in metrics.values()]))
    # Fixed, validation-only selection rule shared by all pilot configurations.
    result = {
        'score': macro_r2 + 0.2 * f1, 'macro_r2': macro_r2,
        'validity_at_0_5': {'precision': precision, 'recall': recall, 'f1': f1},
        'regression': metrics,
    }
    if shrinkage:
        result['shrinkage_deciles'] = tail
    return result


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--points', type=Path, default=DEFAULT_POINTS)
    parser.add_argument('--trims', type=Path, default=DEFAULT_TRIMS)
    parser.add_argument('--epochs', type=int, default=120)
    parser.add_argument('--batch-size', type=int, default=128)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--pool', choices=['max', 'mean', 'maxmean'], default='maxmean')
    parser.add_argument('--patience', type=int, default=20)
    parser.add_argument('--tag', default='trim_pointnet_v1')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--loss', choices=['huber', 'mse'], default='huber')
    parser.add_argument('--target-transform', choices=['raw', 'signed_log1p'], default='raw')
    parser.add_argument('--lambda-cls', type=float, default=0.25)
    parser.add_argument('--dropout', type=float, default=0.1)
    parser.add_argument('--jitter', type=float, default=0.005)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--amp', action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument('--runs', type=Path, default=REPO_ROOT / 'ml/runs')
    parser.add_argument('--resume', type=Path, help='Resume a compatible run, including optimizer state.')
    args = parser.parse_args(argv)
    if min(args.epochs, args.batch_size, args.patience) <= 0 or args.lambda_cls < 0:
        parser.error('epochs/batch/patience must be positive; lambda-cls nonnegative.')
    if args.device.startswith('cuda') and not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable. Use the configured CUDA virtual environment.')
    torch.set_num_threads(4)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if args.device.startswith('cuda'):
        torch.cuda.manual_seed_all(args.seed)
        torch.set_float32_matmul_precision('high')
        torch.backends.cudnn.benchmark = True
    amp = args.amp and args.device.startswith('cuda')
    print(f'Device: {args.device}; torch {torch.__version__}; CUDA {torch.version.cuda}', flush=True)
    if amp:
        print(f'GPU: {torch.cuda.get_device_name(0)}; autocast=bfloat16', flush=True)
    started = time.perf_counter()
    bundle = load_trim_bundle(
        points_path=args.points, trims_path=args.trims, device=args.device,
        target_transform=args.target_transform, include_test=False,
    )
    if 'test' in bundle.indices and len(bundle.indices['test']):
        raise AssertionError('Test designs must not be staged during training.')
    config = {'pool': args.pool, 'encoder_widths': [64, 64, 128, 1024],
              'head_widths': [256, 128], 'dropout': args.dropout}
    model = TrimPointNet(**config).to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='max', patience=8, factor=0.5)
    train_valid = bundle.valid[bundle.indices['train']]
    positives = train_valid.float().sum()
    positive_weight = ((train_valid.numel() - positives) / positives.clamp_min(1)).detach()
    normal = normalization_dict(bundle)
    path = args.runs / f'{args.tag}.pt'
    history_path = args.runs / f'{args.tag}.json'
    last_path = args.runs / f'{args.tag}_last.pt'
    args.runs.mkdir(parents=True, exist_ok=True)
    if path.exists() and args.resume is None:
        raise FileExistsError(f'Run already exists; choose a new --tag or --resume: {path}')
    data_version = {
        'points_sha256': file_hash(args.points), 'trims_sha256': file_hash(args.trims),
        'points': str(args.points.resolve()), 'trims': str(args.trims.resolve()),
    }
    best_score, best_epoch, best_val, history, start_epoch = -float('inf'), 0, None, [], 1
    if args.resume:
        if args.resume.resolve() != last_path.resolve() or not path.is_file():
            raise ValueError('Resume requires the same --tag, its *_last.pt, and its existing best .pt.')
        previous = torch.load(args.resume, map_location=args.device, weights_only=True)
        if not all(key in previous for key in ('optimizer', 'scheduler', 'history', 'cpu_rng', 'cuda_rng')):
            raise ValueError('Resume requires a training *_last.pt checkpoint, not the best inference checkpoint.')
        for key in ('loss', 'lambda_cls', 'jitter', 'batch_size', 'amp', 'lr', 'seed'):
            if previous['args'][key] != getattr(args, key):
                raise ValueError(f'Resume training setting changed: {key}')
        if previous['model_config'] != config or previous['normalization'] != normal:
            raise ValueError('Resume model/normalization differs from this run.')
        for key in ('points_sha256', 'trims_sha256'):
            if previous['data_version'][key] != data_version[key]:
                raise ValueError('Resume dataset fingerprint differs.')
        model.load_state_dict(previous['state_dict'])
        optimizer.load_state_dict(previous['optimizer'])
        scheduler.load_state_dict(previous['scheduler'])
        best_score, best_epoch, best_val = previous['best_score'], previous['best_epoch'], previous['val']
        history = previous['history']
        start_epoch = previous['epoch'] + 1
        torch.set_rng_state(previous['cpu_rng'].cpu())
        if args.device.startswith('cuda'):
            torch.cuda.set_rng_state_all([value.cpu() for value in previous['cuda_rng']])
    print(f'Train designs: {len(bundle.indices["train"]):,}; val: {len(bundle.indices["val"]):,}', flush=True)
    print(f'Valid train rows: {int(positives.item()):,}; BCE pos_weight: {float(positive_weight):.3f}', flush=True)
    print(f'Loss={args.loss}; transform={args.target_transform}; output={path}', flush=True)

    def payload(epoch, val, state):
        return {
            'state_dict': state, 'model_config': config, 'target_names': [str(name) for name in bundle.target_names],
            'normalization': normal, 'train_mean': bundle.raw_mean.tolist(),
            'args': {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
            'best_epoch': best_epoch, 'best_score': best_score, 'val': val,
            'data_paths': {'points': str(args.points.resolve()), 'trims': str(args.trims.resolve())},
            'data_version': data_version, 'epoch': epoch,
            'gpu_name': torch.cuda.get_device_name(0) if args.device.startswith('cuda') else None,
            'torch_version': str(torch.__version__),
        }

    for epoch in range(start_epoch, args.epochs + 1):
        model.train()
        epoch_start = time.perf_counter()
        running = torch.zeros(3, device=args.device)
        batches = 0
        for index in bundle.batches('train', args.batch_size):
            points = bundle.points[index]
            if args.jitter:
                points = points + torch.randn_like(points) * args.jitter
            optimizer.zero_grad(set_to_none=True)
            context = torch.autocast('cuda', dtype=torch.bfloat16) if amp else nullcontext()
            with context:
                regression, logit = model(points, bundle.scale_feature[index])
            regression, logit = regression.float(), logit.float()
            reg_loss = masked_regression_loss(regression, bundle.targets[index], bundle.mask[index], args.loss)
            cls_loss = nn.functional.binary_cross_entropy_with_logits(
                logit, bundle.valid[index].float(), pos_weight=positive_weight
            )
            loss = reg_loss + args.lambda_cls * cls_loss
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0, error_if_nonfinite=True)
            optimizer.step()
            running += torch.stack([loss.detach(), reg_loss.detach(), cls_loss.detach()])
            batches += 1
        val = validate(model, bundle, args.batch_size, amp=amp, shrinkage=epoch == 1 or epoch % 10 == 0)
        score = val['score']
        if not np.isfinite(score):
            raise RuntimeError('Non-finite validation score.')
        scheduler.step(score)
        losses = (running / max(batches, 1)).cpu().tolist()
        entry = {'epoch': epoch, 'train_loss': losses[0], 'regression_loss': losses[1],
                 'classification_loss': losses[2], 'val': val,
                 'seconds': time.perf_counter() - epoch_start,
                 'learning_rate': optimizer.param_groups[0]['lr']}
        history.append(entry)
        improved = score > best_score + 1e-5
        if improved:
            best_score, best_epoch, best_val = score, epoch, val
            state = {name: tensor.detach().cpu() for name, tensor in model.state_dict().items()}
            torch.save(payload(epoch, val, state), path)
        write_json(history_path, {
            'tag': args.tag, 'best_epoch': best_epoch, 'best_score': best_score,
            'best_val': best_val, 'history': history, 'data_version': data_version,
            'selection_rule': 'mean_raw_unit_val_R2_train_mean_reference + 0.2 * val_F1_at_0.5',
            'elapsed_seconds': time.perf_counter() - started, 'test_used': False,
        })
        if epoch % 5 == 0 or epoch == args.epochs or epoch - best_epoch >= args.patience:
            latest = payload(epoch, best_val, model.state_dict())
            latest.update({
                'optimizer': optimizer.state_dict(), 'scheduler': scheduler.state_dict(),
                'history': history, 'cpu_rng': torch.get_rng_state(),
                'cuda_rng': torch.cuda.get_rng_state_all() if args.device.startswith('cuda') else [],
            })
            torch.save(latest, last_path)
        print(f'Epoch {epoch:3d}: loss {losses[0]:.4f}; val R2 {val["macro_r2"]:.4f}; '
              f'F1 {val["validity_at_0_5"]["f1"]:.4f}; score {score:.4f}; '
              f'{entry["seconds"]:.1f}s' + (' *' if improved else ''), flush=True)
        if epoch - best_epoch >= args.patience:
            print(f'Early stop: best epoch {best_epoch}', flush=True)
            break
    print(f'Complete. Checkpoint: {path}; best epoch {best_epoch}; {time.perf_counter()-started:.1f}s', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
