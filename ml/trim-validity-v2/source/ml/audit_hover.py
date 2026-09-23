"""Audit corrupt hover supervision without changing source labels or datasets.

The user supplied a known failure: drag=NaN, maxUc=0.5, and thrust much
smaller than mass*g at speed zero. Missing drag alone is NOT corruption.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

G = 9.80665


def hover_flags(raw, mass, valid_hover):
    """Return signature, ratio, suspect, trusted using fixed physical criteria.

    This function does not inspect predictions, data splits or dataset-level
    quantiles. This identifies failed speed-zero payloads; exact copies may
    also be excluded. A bad row is missing supervision, not an invalid label.
    """
    raw = np.asarray(raw)
    mass = np.asarray(mass, dtype=np.float64)
    valid_hover = np.asarray(valid_hover, dtype=bool)
    if raw.shape[-2:] != (51, 12):
        raise ValueError('Expected (..., 51, 12) raw trims')
    hover = raw[..., 0, :]
    signature = ~np.isfinite(hover[..., 6]) & (hover[..., 3] == 0.5)
    mass_ok = np.isfinite(mass) & (mass > 0)
    ratio = np.divide(hover[..., 4], mass * G,
                      out=np.full_like(mass, np.nan), where=mass_ok)
    suspect = signature & mass_ok & np.isfinite(ratio) & (ratio < 0.5)
    trusted = (valid_hover & ~signature & mass_ok & np.isfinite(ratio)
               & (np.abs(ratio - 1.0) <= 0.1))
    return signature, ratio, suspect, trusted


def failed_hover_clone_rows(raw, suspect_hover):
    """Exclude the failed hover and its exact non-distance payload clones.

    Compare all 11 columns after distance, using exact equality with equal NaNs.
    A merely similar row or a non-hover signature in a clean design is kept.
    """
    payload = np.asarray(raw)[..., 1:]
    hover_payload = payload[..., 0:1, :]
    identical = np.all((payload == hover_payload)
                       | (np.isnan(payload) & np.isnan(hover_payload)), axis=-1)
    return np.asarray(suspect_hover)[..., None] & identical


def self_test():
    rows = np.zeros((7, 51, 12), dtype=np.float64)
    rows[:, 0, 4] = 10 * G
    rows[:, 0, 3] = 0.6
    rows[0, 0, [3, 4, 6]] = [0.5, 19.27, np.nan]
    rows[1, 0, 6] = np.nan  # Missing drag alone is allowed.
    rows[2, 0, [3, 6]] = [0.5, np.nan]  # Signature, good force balance.
    rows[3, 0, [3, 4, 6]] = [0.5, 10, np.nan]
    rows[4, 1, [3, 4, 6]] = [0.5, 10, np.nan]  # Non-hover untouched.
    rows[5, 0, [3, 4, 6]] = [0.500000001, 10, np.nan]
    rows[6, 0, [3, 4, 6]] = [0.5, 5 * G, np.nan]  # Strict ratio boundary.
    mass = np.full(7, 10.0)
    mass[0] = 7.3711756524692
    mass[3] = np.nan
    signature, ratio, suspect, trusted = hover_flags(rows, mass, np.ones(7, bool))
    assert suspect.tolist() == [True, False, False, False, False, False, False]
    assert trusted[1] and trusted[4] and not trusted[2]
    assert signature[2] and signature[3] and not signature[5]
    assert np.isclose(ratio[0], 19.27 / (7.3711756524692 * G))
    assert np.isnan(ratio[3])
    rows[0, 1:4] = rows[0, 0]
    rows[0, 1, 0] = 999.0  # Distance is allowed to differ.
    rows[0, 2, 4] += 1e-10  # Even a tiny non-distance change is not exact.
    rows[0, 3, 6] = 0.0  # Missing drag must match too.
    rows[2, 1] = rows[2, 0]  # Clean-hover clones are not corrupt.
    bad_rows = failed_hover_clone_rows(rows, suspect)
    assert np.flatnonzero(bad_rows[0]).tolist() == [0, 1]
    assert not bad_rows[1:].any()
    assert not bad_rows[:, 50].any()  # Empty invalid rows stay supervised.
    print('Synthetic hover audit tests passed.', flush=True)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def audit(points_path, trims_path, raw_root, out_dir):
    with np.load(points_path, allow_pickle=False) as points, np.load(trims_path, allow_pickle=False) as trims:
        ids = trims['design_id'].copy()
        split = trims['split'].copy()
        original_valid = trims['trim_valid'].copy()
        original_regmask = trims['regression_mask'].copy()
        point_ids = points['design_id']
        point_positions = {int(value): i for i, value in enumerate(point_ids)}
        if len(point_positions) != len(point_ids) or set(point_positions) != set(ids.tolist()):
            raise ValueError('Point and trim design IDs differ or are duplicated')
        order = np.asarray([point_positions[int(value)] for value in ids])
        names = points['target_names'].astype(str).tolist()
        mass = points['targets'][order, names.index('Mass')].astype(np.float64)
    raw_paths = {}
    for part in sorted(Path(raw_root).glob('AircraftVerse_*')):
        for directory in part.glob('design_*'):
            if not directory.is_dir():
                continue
            design_id = int(directory.name.removeprefix('design_'))
            if design_id in raw_paths:
                raise ValueError(f'Duplicate raw design {design_id}')
            raw_paths[design_id] = directory / 'trims.npy'
    if not set(ids.tolist()).issubset(raw_paths):
        raise ValueError('Missing raw trim files')

    n = len(ids)
    signature = np.zeros(n, bool)
    suspect = np.zeros(n, bool)
    suspect_rows = np.zeros((n, 51), bool)
    trusted = np.zeros(n, bool)
    ratio = np.full(n, np.nan)
    thrust = np.full(n, np.nan)
    all_speed_signature_count = np.zeros(n, np.int32)
    identical_signature_all_speeds = np.zeros(n, bool)
    for i, design_id in enumerate(ids):
        raw = np.load(raw_paths[int(design_id)], allow_pickle=False)
        if raw.shape != (51, 12):
            raise ValueError(f'Bad raw trim shape for {design_id}: {raw.shape}')
        sig, rat, bad, good = hover_flags(raw[None], mass[i:i+1], original_valid[i:i+1, 0])
        signature[i], ratio[i], suspect[i], trusted[i] = sig[0], rat[0], bad[0], good[0]
        thrust[i] = raw[0, 4]
        suspect_rows[i] = failed_hover_clone_rows(raw[None], bad)[0]
        sig_rows = ~np.isfinite(raw[:, 6]) & (raw[:, 3] == 0.5)
        all_speed_signature_count[i] = sig_rows.sum()
        identical_signature_all_speeds[i] = bool(sig_rows.all() and np.allclose(raw[:, 1:], raw[0, 1:], equal_nan=True))
        if (i + 1) % 3000 == 0:
            print(f'Audited {i+1:,}/{n:,} designs', flush=True)

    supervised = ~suspect_rows
    # Keep explicit names compatible with downstream code while retaining the
    # full independent mask rather than overwriting source labels.
    trusted_hover = np.zeros_like(original_valid, bool)
    trusted_hover[:, 0] = trusted
    rule = ('speed==0 and not isfinite(drag) and maxUc==0.5 and '
            'isfinite(Mass) and Mass>0 and isfinite(thrust/(Mass*9.80665)) '
            'and thrust/(Mass*9.80665)<0.5')
    by_split = {}
    for name in ('train', 'val', 'test'):
        take = split == name
        by_split[name] = {
            'designs': int(take.sum()),
            'original_valid_rows': int(original_valid[take].sum()),
            'hover_full_signature': int((signature & take).sum()),
            'hover_full_signature_under_half_weight': int((suspect & take).sum()),
            'signature_hover_relative_force_error_over_20pct': int((signature & take & (np.abs(ratio-1)>0.2)).sum()),
            'excluded_original_positive_rows': int((suspect_rows[take] & original_valid[take]).sum()),
            'excluded_original_negative_rows': int((suspect_rows[take] & ~original_valid[take]).sum()),
            'excluded_regression_observations': int((original_regmask[take] & suspect_rows[take, :, None]).sum()),
            'exact_failed_hover_payload_clone_rows': int(suspect_rows[take, 1:].sum()),
            'trusted_hover_rows': int((trusted & take).sum()),
            'all_speed_full_signature_rows': int(all_speed_signature_count[take].sum()),
            'all_speeds_identical_signature_designs': int((identical_signature_all_speeds & take).sum()),
            'excluded_design_ids': ids[suspect & take].tolist(),
        }
    evidence = [{
        'design_id': int(ids[i]), 'split': str(split[i]), 'speed': 0,
        'mass_kg': float(mass[i]), 'thrust_n': float(thrust[i]),
        'weight_n': float(mass[i] * G), 'thrust_weight_ratio': float(ratio[i]),
        'original_valid': bool(original_valid[i, 0]),
        'excluded_speeds': np.flatnonzero(suspect_rows[i]).tolist(),
        'row_reasons': {str(speed): ('corrupt_hover_force_signature' if speed == 0 else 'exact_failed_hover_payload_clone') for speed in np.flatnonzero(suspect_rows[i])},
        'all_speed_signature_rows': int(all_speed_signature_count[i]),
        'all_speeds_identical_signature': bool(identical_signature_all_speeds[i]),
    } for i in np.flatnonzero(suspect)]
    report = {
        'rule': rule,
        'clone_extension_rule': 'Flag any row whose 11 non-distance columns are exactly equal (equal_nan) to a hover flagged by the rule.',
        'clone_reason': 'exact_failed_hover_payload_clone',
        'rule_source': 'User-reported failure signature plus fixed gross hover force mismatch, independent of predictions.',
        'mask_semantics': 'False means unknown/untrusted supervision; original labels are unchanged, not made negative.',
        'scope': 'Exclude failed speed-zero payloads and exact non-distance clones; no force assumption is applied to arbitrary nonzero-speed rows.',
        'trusted_hover_rule': 'Original valid hover; no full signature; positive finite Mass; abs(thrust/(Mass*g)-1)<=0.1.',
        'physics_loss_restriction': 'Use trusted_hover rows from TRAIN designs only, with actual Mass, never predicted Mass anchoring.',
        'evaluation_requirement': 'Report both legacy labels and clean masked metrics; choose models and thresholds using validation only.',
        'design_count': int(n), 'excluded_hover_designs': int(suspect.sum()), 'excluded_rows': int(suspect_rows.sum()),
        'split_counts': by_split, 'excluded_evidence': evidence,
        'source_paths': {'points': str(Path(points_path).resolve()), 'trims': str(Path(trims_path).resolve()), 'raw_root': str(Path(raw_root).resolve())},
        'source_sha256': {'points': sha256(points_path), 'trims': sha256(trims_path)},
    }
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    mask_path = out_dir / 'hover_supervision_masks.npz'
    report_path = out_dir / 'hover_audit.json'
    np.savez_compressed(mask_path, design_id=ids, split=split, supervised_mask=supervised,
                        classification_mask=supervised, trusted_hover=trusted,
                        trusted_hover_mask=trusted_hover, suspect_hover=suspect, suspect_rows=suspect_rows, mass_kg=mass)
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    if 20015 in ids:
        known = int(np.flatnonzero(ids == 20015)[0])
        assert not supervised[known, :50].any(), 'Known corrupt hover and its 49 payload clones must be masked'
        assert supervised[known, 50] and not original_valid[known, 50], 'Empty invalid row remains supervised'
    assert supervised.shape == original_valid.shape
    assert np.count_nonzero(~supervised) == int(suspect_rows.sum())
    assert np.array_equal(suspect_rows[:, 0], suspect)
    print(json.dumps({'mask': str(mask_path), 'report': str(report_path),
                      'excluded_rows': int(suspect_rows.sum()), 'by_split': {name: {k:v for k,v in counts.items() if k!='excluded_design_ids'} for name, counts in by_split.items()}}, indent=2), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--points', type=Path, default=Path('ml/data/pointclouds.npz'))
    parser.add_argument('--trims', type=Path, default=Path('ml/data/trims.npz'))
    parser.add_argument('--raw-root', type=Path, default=Path('data/raw'))
    parser.add_argument('--out-dir', type=Path, default=Path('outputs/trim-validity-v2/data'))
    parser.add_argument('--self-test-only', action='store_true')
    args = parser.parse_args()
    self_test()
    if not args.self_test_only:
        audit(args.points, args.trims, args.raw_root, args.out_dir)


if __name__ == '__main__':
    main()

