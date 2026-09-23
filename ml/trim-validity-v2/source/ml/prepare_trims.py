"""Stage 6: prepare every design's speed-conditioned trim supervision.

Validity uses the complete 12-column row and common.trim_row_valid exactly.
A missing target masks only that target, never the other regression tasks.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np

from common import (
    REPO_ROOT, TRIM_FIELDS, TRIMS_SCHEMA, add_data_root_arg, iter_design_dirs,
    read_npy_header, resolve_roots, schema_matches, trim_row_valid, write_json,
)
from prepare_targets import FAMILY_RE, SPLIT_SALT, assign_split

TARGET_NAMES = ['pitch', 'drag', 'thrust', 'flightTime', 'power', 'current']
DEFAULT_TRIMS = REPO_ROOT / 'ml' / 'data' / 'trims.npz'
TARGET_INDICES = [TRIM_FIELDS.index(name) for name in TARGET_NAMES]


def extract_trim_supervision(trims: np.ndarray):
    """Return six raw targets, row validity, and per-target regression mask."""
    if trims.shape != TRIMS_SCHEMA[1] or trims.dtype.str != TRIMS_SCHEMA[0]:
        raise ValueError(f'Unexpected trim schema: {trims.dtype.str} {trims.shape}')
    valid = np.fromiter((trim_row_valid(row) for row in trims), dtype=bool, count=51)
    targets = trims[:, TARGET_INDICES].astype(np.float32)
    mask = valid[:, None] & np.isfinite(targets)
    return targets, valid, mask


def family_from_low_level(low_level: dict) -> str:
    name = low_level.get('name') or ''
    match = FAMILY_RE.match(name)
    family = match.group(1) if match else name
    if not family:
        raise ValueError('Missing design family in design_low_level.json')
    return family


def prepare_trims(roots: list[Path], out: Path = DEFAULT_TRIMS,
                  report_path: Path | None = None, limit: int | None = None):
    tasks = sorted((design_id, directory) for root in roots
                   for design_id, directory in iter_design_dirs(root))
    ids = [design_id for design_id, _ in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate raw design IDs across data roots')
    if limit is not None:
        if limit <= 0:
            raise ValueError('limit must be positive')
        tasks = tasks[:limit]
    if not tasks:
        raise ValueError('No raw designs found')

    started = time.time()
    count = len(tasks)
    design_ids = np.asarray([item[0] for item in tasks], dtype=np.int32)
    trims = np.empty((count, 51, len(TARGET_NAMES)), dtype=np.float32)
    valid = np.empty((count, 51), dtype=bool)
    mask = np.empty_like(trims, dtype=bool)
    families, splits = [], []
    for number, (design_id, directory) in enumerate(tasks):
        path = directory / 'trims.npy'
        if not schema_matches(read_npy_header(path), TRIMS_SCHEMA):
            raise ValueError(f'Unexpected raw trim schema for design {design_id}: {path}')
        raw = np.load(path, allow_pickle=False)
        trims[number], valid[number], mask[number] = extract_trim_supervision(raw)
        low_level = json.loads((directory / 'design_low_level.json').read_text(encoding='utf-8'))
        family = family_from_low_level(low_level)
        families.append(family)
        splits.append(assign_split(family))
        if (number + 1) % 2000 == 0:
            print(f'  trims {number + 1}/{count} ({time.time() - started:.0f}s)', flush=True)

    split = np.asarray(splits)
    family = np.asarray(families)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, design_id=design_ids, trim=trims, trim_valid=valid,
                        regression_mask=mask, split=split, family=family,
                        target_names=np.asarray(TARGET_NAMES))
    valid_counts = valid.sum(axis=1)
    interval_counts = np.count_nonzero(np.diff(
        np.pad(valid.astype(np.int8), ((0, 0), (1, 1))), axis=1) == 1, axis=1)
    first = np.where(valid.any(axis=1), valid.argmax(axis=1), -1)
    last = np.where(valid.any(axis=1), 50 - valid[:, ::-1].argmax(axis=1), -1)
    report = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'stage6_passed': True,
        'designs': count,
        'total_speed_rows': int(valid.size),
        'valid_speed_rows': int(valid.sum()),
        'invalid_speed_rows': int((~valid).sum()),
        'designs_without_valid_trim': int((valid_counts == 0).sum()),
        'target_names': TARGET_NAMES,
        'valid_rows_by_speed': valid.sum(axis=0),
        'regression_observations_by_target': dict(zip(TARGET_NAMES, mask.sum(axis=(0, 1)))),
        'nonfinite_targets_in_valid_rows': dict(zip(TARGET_NAMES,
            (valid[:, :, None] & ~np.isfinite(trims)).sum(axis=(0, 1)))),
        'regression_observations_by_speed': mask.sum(axis=0),
        'valid_speed_count_histogram': dict(sorted(Counter(valid_counts.tolist()).items())),
        'valid_interval_count_histogram': dict(sorted(Counter(interval_counts.tolist()).items())),
        'first_valid_speed_histogram': dict(sorted(Counter(first.tolist()).items())),
        'last_valid_speed_histogram': dict(sorted(Counter(last.tolist()).items())),
        'split_sizes': {name: int((split == name).sum()) for name in ('train', 'val', 'test')},
        'split_valid_rows': {name: int(valid[split == name].sum()) for name in ('train', 'val', 'test')},
        'split_target_observations': {name: dict(zip(TARGET_NAMES, mask[split == name].sum(axis=(0, 1))))
                                      for name in ('train', 'val', 'test')},
        'families': len(set(families)),
        'split_salt': SPLIT_SALT,
        'validity_rule': 'common.trim_row_valid(full 12-column row)',
        'regression_mask_rule': 'trim_valid[..., None] & isfinite(each target)',
        'retained_population': 'All designs, including designs without any valid speed',
        'output': str(out.resolve()),
        'elapsed_seconds': round(time.time() - started, 2),
    }
    if report_path is not None:
        write_json(report_path, report)
    print(f'Stage 6: {count} designs; {int(valid.sum())}/{valid.size} valid rows', flush=True)
    print(f'Trims -> {out}', flush=True)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description='Stage 6 trim targets and validity')
    add_data_root_arg(parser)
    parser.add_argument('--out', type=Path, default=DEFAULT_TRIMS)
    parser.add_argument('--report', type=Path, default=REPO_ROOT / 'ml/reports/stage6_trims.json')
    parser.add_argument('--limit', type=int, default=None)
    args = parser.parse_args(argv)
    prepare_trims(resolve_roots(args.data_root), args.out, args.report, args.limit)
    return 0


if __name__ == '__main__':
    sys.exit(main())