"""Join trim supervision to geometry by ID and stage design batches on a device."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from common import REPO_ROOT
from prepare_targets import assign_split
from prepare_trims import DEFAULT_TRIMS, TARGET_NAMES

DEFAULT_POINTS = REPO_ROOT / 'ml' / 'data' / 'pointclouds.npz'
SPLITS = ('train', 'val', 'test')


@dataclass
class TrimBundle:
    points: torch.Tensor
    scale_feature: torch.Tensor
    targets: torch.Tensor
    mask: torch.Tensor
    valid: torch.Tensor
    raw_targets: np.ndarray
    design_id: np.ndarray
    split: np.ndarray
    family: np.ndarray
    mean: np.ndarray
    std: np.ndarray
    raw_mean: np.ndarray
    scale_log_mean: float
    scale_log_std: float
    target_names: list[str]
    indices: dict[str, torch.Tensor]
    target_transform: str = 'raw'

    def batches(self, split: str, batch_size: int, generator=None):
        index = self.indices[split]
        order = torch.randperm(len(index), generator=generator, device=index.device)
        for start in range(0, len(index), batch_size):
            yield index[order[start:start + batch_size]]

    def sequential(self, split: str, batch_size: int):
        index = self.indices[split]
        for start in range(0, len(index), batch_size):
            yield index[start:start + batch_size]


def normalization_dict(bundle: TrimBundle) -> dict:
    return {
        'target_mean': bundle.mean.tolist(), 'target_std': bundle.std.tolist(),
        'scale_log_mean': bundle.scale_log_mean, 'scale_log_std': bundle.scale_log_std,
        'target_transform': bundle.target_transform,
    }


def inverse_targets(values, bundle_or_normalization):
    """Decode standardized predictions to raw units, preserving numpy/tensor type."""
    stats = (normalization_dict(bundle_or_normalization)
             if isinstance(bundle_or_normalization, TrimBundle) else bundle_or_normalization)
    transform = stats.get('target_transform', 'raw')
    if transform not in ('raw', 'signed_log1p'):
        raise ValueError(f'Unknown target transform: {transform}')
    if isinstance(values, torch.Tensor):
        mean = torch.as_tensor(stats['target_mean'], dtype=values.dtype, device=values.device)
        std = torch.as_tensor(stats['target_std'], dtype=values.dtype, device=values.device)
        decoded = values * std + mean
        return decoded if transform == 'raw' else torch.sign(decoded) * torch.expm1(decoded.abs())
    decoded = np.asarray(values) * np.asarray(stats['target_std']) + np.asarray(stats['target_mean'])
    return decoded if transform == 'raw' else np.sign(decoded) * np.expm1(np.abs(decoded))


def _metadata(data, source):
    ids = np.asarray(data['design_id'])
    split = np.asarray(data['split']).astype(str)
    family = np.asarray(data['family']).astype(str)
    if ids.ndim != 1 or not np.issubdtype(ids.dtype, np.integer):
        raise ValueError(f'{source}: design_id must be a one-dimensional integer array')
    if len(np.unique(ids)) != len(ids):
        raise ValueError(f'{source}: duplicate design IDs')
    if split.shape != ids.shape or family.shape != ids.shape:
        raise ValueError(f'{source}: split/family shape mismatch')
    if np.any(family == '') or not np.isin(split, SPLITS).all():
        raise ValueError(f'{source}: missing family or invalid split')
    assigned = np.asarray([assign_split(value) for value in family])
    if not np.array_equal(split, assigned):
        raise ValueError(f'{source}: split does not match assign_split(family)')
    return ids, split, family


def load_trim_bundle(points_path: Path = DEFAULT_POINTS, trims_path: Path = DEFAULT_TRIMS,
                     device: str = 'cuda', target_transform: str = 'raw',
                     normalization: dict | None = None, include_test: bool = True) -> TrimBundle:
    """Strict ID join; keep every design for validity classification.

    With include_test=False no test points or target values are staged. Target
    and scale statistics always use training designs only. Restored checkpoint
    normalization takes precedence over target_transform.
    """
    with np.load(points_path, allow_pickle=False) as points_data, \
            np.load(trims_path, allow_pickle=False) as trim_data:
        point_ids, point_split, point_family = _metadata(points_data, 'pointclouds')
        trim_ids, trim_split, trim_family = _metadata(trim_data, 'trims')
        if set(point_ids.tolist()) != set(trim_ids.tolist()):
            raise ValueError('pointclouds and trims have different design ID sets')
        positions = {int(value): index for index, value in enumerate(trim_ids)}
        order = np.asarray([positions[int(value)] for value in point_ids])
        if not np.array_equal(point_split, trim_split[order]):
            raise ValueError('Split mismatch for joined design IDs')
        if not np.array_equal(point_family, trim_family[order]):
            raise ValueError('Family mismatch for joined design IDs')
        names = [str(value) for value in trim_data['target_names']]
        if names != TARGET_NAMES:
            raise ValueError(f'Unexpected trim target names/order: {names}')
        raw_all = trim_data['trim']
        valid_all = trim_data['trim_valid']
        mask_all = trim_data['regression_mask']
        expected_shape = (len(trim_ids), 51, len(TARGET_NAMES))
        if raw_all.shape != expected_shape or valid_all.shape != expected_shape[:2] or mask_all.shape != expected_shape:
            raise ValueError('Invalid trim/validity/mask shapes')
        if valid_all.dtype != np.bool_ or mask_all.dtype != np.bool_:
            raise ValueError('Validity and regression_mask must be boolean arrays')
        if not np.array_equal(mask_all, valid_all[:, :, None] & np.isfinite(raw_all)):
            raise ValueError('Regression mask differs from validity and finite target mask')
        keep = np.ones(len(point_ids), dtype=bool) if include_test else point_split != 'test'
        points = np.asarray(points_data['points'][keep], dtype=np.float32)
        scale = np.asarray(points_data['scale'][keep], dtype=np.float64)
        raw = np.asarray(raw_all[order[keep]], dtype=np.float64)
        valid = valid_all[order[keep]]
        mask = mask_all[order[keep]]
        design_id, split, family = point_ids[keep], point_split[keep], point_family[keep]
    if points.ndim != 3 or points.shape[0] != len(raw) or points.shape[2] != 3 or points.shape[1] == 0:
        raise ValueError('Expected points shape (N, P, 3)')
    if not np.isfinite(points).all() or scale.shape != (len(raw),) or not np.isfinite(scale).all() or (scale <= 0).any():
        raise ValueError('Points must be finite and scale must be finite and positive')
    train = split == 'train'
    if not train.any():
        raise ValueError('No training designs')
    if normalization is not None:
        target_transform = normalization.get('target_transform', 'raw')
    if target_transform not in ('raw', 'signed_log1p'):
        raise ValueError(f'Unknown target transform: {target_transform}')
    safe = np.where(mask, raw, 0.0)
    transformed = safe if target_transform == 'raw' else np.sign(safe) * np.log1p(np.abs(safe))
    means, stds, raw_mean = [], [], []
    for column, name in enumerate(names):
        usable = train[:, None] & mask[:, :, column]
        if not usable.any():
            raise ValueError(f'Target {name} has no valid training rows')
        values = transformed[:, :, column][usable]
        means.append(float(values.mean()))
        stds.append(float(values.std()) or 1.0)
        raw_mean.append(float(raw[:, :, column][usable].mean()))
    mean, std = np.asarray(means), np.asarray(stds)
    log_scale = np.log(scale)
    scale_mean = float(log_scale[train].mean())
    scale_std = float(log_scale[train].std()) or 1.0
    if normalization is not None:
        mean = np.asarray(normalization['target_mean'], dtype=np.float64)
        std = np.asarray(normalization['target_std'], dtype=np.float64)
        scale_mean = float(normalization['scale_log_mean'])
        scale_std = float(normalization['scale_log_std'])
        if mean.shape != (len(names),) or std.shape != (len(names),) or not np.isfinite(mean).all() or not np.isfinite(std).all() or (std <= 0).any():
            raise ValueError('Invalid checkpoint target normalization')
        if not np.isfinite(scale_mean) or not np.isfinite(scale_std) or scale_std <= 0:
            raise ValueError('Invalid checkpoint scale normalization')
    standardized = np.where(mask, (transformed - mean) / std, 0).astype(np.float32)
    scale_feature = ((log_scale - scale_mean) / scale_std)[:, None].astype(np.float32)
    torch_device = torch.device(device)
    return TrimBundle(
        points=torch.from_numpy(points).permute(0, 2, 1).contiguous().to(torch_device),
        scale_feature=torch.from_numpy(scale_feature).to(torch_device),
        targets=torch.from_numpy(standardized).to(torch_device),
        mask=torch.from_numpy(mask).to(torch_device),
        valid=torch.from_numpy(valid).to(torch_device),
        raw_targets=np.where(mask, raw, np.nan), design_id=design_id,
        split=split, family=family, mean=mean, std=std, raw_mean=np.asarray(raw_mean),
        scale_log_mean=scale_mean, scale_log_std=scale_std, target_names=names,
        indices={name: torch.from_numpy(np.flatnonzero(split == name)).to(torch_device) for name in SPLITS},
        target_transform=target_transform,
    )