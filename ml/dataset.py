"""Dataset access for stage 3.

The whole training set is 340 MB, so it is loaded once and kept resident on the
GPU. There is no DataLoader and no per-batch host transfer; batches are index
selections into device tensors.

Targets are addressed by name through TARGET_SPECS. Beyond the KPIs, the
registry carries the debugging-ladder rungs from docs/HANDOFF.md, including the
scale-invariant ones: `span` is 92.6% predictable from log(scale) alone, so it
only proves the scale input is wired up. A ratio target cannot be answered from
scale at all, which is what makes it a real test of whether the cloud is read.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from common import REPO_ROOT

DEFAULT_DATA = REPO_ROOT / "ml" / "data" / "pointclouds.npz"


def _kpi(name: str):
    def extract(data):
        index = list(data["target_names"]).index(name)
        values = data["targets"][:, index].astype(np.float64)
        return values, np.isfinite(values)

    return extract


def _geometry(name: str):
    def extract(data):
        index = list(data["geometry_names"]).index(name)
        values = data["geometry"][:, index].astype(np.float64)
        return values, np.isfinite(values) & (values > 0)

    return extract


def _span(data):
    values = data["span"].astype(np.float64)
    return values, np.isfinite(values) & (values > 0)


def _aspect_zx(data):
    extents = data["extents"].astype(np.float64)
    valid = np.isfinite(extents).all(axis=1) & (extents[:, 0] > 0)
    values = np.divide(extents[:, 2], extents[:, 0], out=np.zeros(len(extents)), where=valid)
    return values, valid & np.isfinite(values) & (values > 0)


def _fuselage_vert_ratio(data):
    index = list(data["geometry_names"]).index("fuselage_vert_diameter")
    diameter = data["geometry"][:, index].astype(np.float64)
    scale = data["scale"].astype(np.float64)
    valid = np.isfinite(diameter) & (diameter > 0) & (scale > 0)
    values = np.divide(diameter, scale, out=np.zeros(len(scale)), where=valid)
    return values, valid & np.isfinite(values)


# Ladder rungs are marked so train.py can say what a result actually proves.
TARGET_SPECS = {
    # rung 1a — wiring check. Reachable from log(scale) alone at R2 0.926.
    "span": (_span, "mm", "rung1a"),
    # rung 1b — scale-invariant. Requires reading the normalised cloud.
    "aspect_zx": (_aspect_zx, "ratio", "rung1b"),
    "fuselage_vert_ratio": (_fuselage_vert_ratio, "ratio", "rung1b"),
    # absolute geometry, still a pipeline check but a harder one
    "fuselage_length": (_geometry("fuselage_length"), "mm", "rung1"),
    "fuselage_vert_diameter": (_geometry("fuselage_vert_diameter"), "mm", "rung1"),
    "arm_length_max": (_geometry("arm_length_max"), "mm", "rung1"),
    # rung 2 and 3 — the real KPIs
    "Mass": (_kpi("Mass"), "kg", "rung2"),
    "Max_Distance": (_kpi("Max_Distance"), "m", "rung3"),
    "Hover_Time": (_kpi("Hover_Time"), "s", "rung3"),
    "Max_Speed": (_kpi("Max_Speed"), "m/s", "rung3"),
    "Power_MFD": (_kpi("Power_MFD"), "W", "rung3"),
}


@dataclass
class Bundle:
    """Everything training needs, already on the target device."""

    points: torch.Tensor        # (N, 3, P) — channels first for Conv1d
    scale_feature: torch.Tensor  # (N, 1) — standardised log(scale)
    targets: torch.Tensor       # (N, T) — standardised, 0 where masked
    mask: torch.Tensor          # (N, T) — bool, True where the target is usable
    raw_targets: np.ndarray     # (N, T) — original units, NaN where masked
    indices: dict[str, torch.Tensor]
    target_names: list[str]
    units: list[str]
    rungs: list[str]
    mean: np.ndarray            # (T,) train mean, raw units
    std: np.ndarray             # (T,) train std, raw units
    design_id: np.ndarray
    # Standardisation of log(scale), fitted on train. Inference is impossible
    # without these two numbers, so they travel with every checkpoint.
    scale_log_mean: float = 0.0
    scale_log_std: float = 1.0

    def batches(self, split: str, batch_size: int, generator=None):
        index = self.indices[split]
        order = torch.randperm(len(index), generator=generator, device=index.device)
        for start in range(0, len(index), batch_size):
            yield index[order[start : start + batch_size]]

    def sequential(self, split: str, batch_size: int):
        index = self.indices[split]
        for start in range(0, len(index), batch_size):
            yield index[start : start + batch_size]


def load_bundle(
    target_names: list[str],
    path: Path = DEFAULT_DATA,
    device: str = "cuda",
    require_all_targets: bool = False,
) -> Bundle:
    """Load the npz and stage it on `device`.

    `require_all_targets` keeps only designs usable for every requested target.
    The default keeps any design usable for at least one, and masks the rest,
    which is what multi-task training wants: Mass contributes ~17,000 rows that
    Max_Distance does not have.
    """
    unknown = [name for name in target_names if name not in TARGET_SPECS]
    if unknown:
        raise SystemExit(
            f"unknown target(s): {unknown}\navailable: {sorted(TARGET_SPECS)}"
        )

    data = np.load(path, allow_pickle=False)
    split = data["split"]

    columns, masks, units, rungs = [], [], [], []
    for name in target_names:
        extract, unit, rung = TARGET_SPECS[name]
        values, valid = extract(data)
        columns.append(values)
        masks.append(valid)
        units.append(unit)
        rungs.append(rung)

    raw = np.column_stack(columns)
    mask = np.column_stack(masks)
    keep = mask.all(axis=1) if require_all_targets else mask.any(axis=1)

    raw, mask, split = raw[keep], mask[keep], split[keep]
    points = data["points"][keep]
    scale = data["scale"][keep].astype(np.float64)
    design_id = data["design_id"][keep]

    # Standardise targets on the training split only.
    is_train = split == "train"
    mean = np.zeros(raw.shape[1])
    std = np.ones(raw.shape[1])
    for column in range(raw.shape[1]):
        usable = is_train & mask[:, column]
        if usable.sum() < 2:
            raise SystemExit(f"target {target_names[column]} has no training rows")
        mean[column] = raw[usable, column].mean()
        std[column] = raw[usable, column].std() or 1.0

    standardised = np.where(mask, (raw - mean) / std, 0.0)
    raw_masked = np.where(mask, raw, np.nan)

    # log(scale) spans 165-3027 mm and is right-skewed; standardise it too,
    # again on train only.
    log_scale = np.log(scale)
    scale_mean = float(log_scale[is_train].mean())
    scale_std = float(log_scale[is_train].std()) or 1.0
    scale_feature = ((log_scale - scale_mean) / scale_std)[:, None]

    torch_device = torch.device(device)
    bundle = Bundle(
        points=torch.from_numpy(points).permute(0, 2, 1).contiguous().to(torch_device),
        scale_feature=torch.from_numpy(scale_feature).float().to(torch_device),
        targets=torch.from_numpy(standardised).float().to(torch_device),
        mask=torch.from_numpy(mask).to(torch_device),
        raw_targets=raw_masked,
        indices={
            name: torch.from_numpy(np.flatnonzero(split == name)).to(torch_device)
            for name in ("train", "val", "test")
        },
        target_names=list(target_names),
        units=units,
        rungs=rungs,
        mean=mean,
        std=std,
        design_id=design_id,
        scale_log_mean=scale_mean,
        scale_log_std=scale_std,
    )
    return bundle
