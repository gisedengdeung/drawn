"""Does the browser's concept shape work as model input instead of the real STL?

The models were trained on cadfile.stl, a CAD mesh with thousands of triangles.
But the moment a user edits a design in Design Studio there is no STL: the
browser only has the concept shape that components/parametric-uav-viewer.tsx
assembles out of cylinders, boxes and spheres. Feeding points sampled from that
into the model is out of distribution, and the model will not complain - it will
just return confident numbers.

That matters because editing is the whole point of the feature. Dataset designs
already have their answers in trims.npy; the model is only needed for shapes
that do not exist yet.

This script builds the concept shape in Python from the same DesignDraft
parameters the viewer uses, samples it the same way, and compares the
predictions against the ones from the real STL.

    python ml/check_parametric_gap.py

The yardstick is the resampling spread already measured in
ml/reports/sampling_variance.json: simply reseeding the sampler moves
Max_Distance by 10-20%. A concept-shape gap inside that band is not worth
worrying about. A gap several times larger means the concept shape cannot drive
the model and editing must fall back to something else.

Writes ml/reports/parametric_gap.json. Output is ASCII only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "ml" / "runs"
DATA = REPO_ROOT / "public" / "data"
MODELS = REPO_ROOT / "public" / "models"
DEFAULT_OUT = REPO_ROOT / "ml" / "reports" / "parametric_gap.json"

SEED_SALT = 0x9E3779B1
N_POINTS = 1024
MM_PER_INCH = 25.4
TRIM_TARGETS = ("pitch", "drag", "thrust", "flightTime", "power", "current")

MISSING = """\
Needs the ONNX files in ml/runs/ (gitignored, so not in the repo):
    pointnet-geometry-v1.onnx
    trim-encoder-v1.onnx
    trim-head-v1.onnx
Get them from the team drive.
"""


def design_seed(design_id: int) -> int:
    return (design_id * SEED_SALT) % (2**32)


def propeller_diameter_mm(name: str | None) -> float:
    """apc_propellers_15x5_5MR -> 15 inch -> 381 mm. Same parse as the viewer."""
    if not name:
        return 254.0
    tail = name.replace("apc_propellers_", "")
    head = tail.split("x")[0].replace("_", ".")
    try:
        return float(head) * MM_PER_INCH
    except ValueError:
        return 254.0


def build_concept_mesh(summary: dict, showcase: dict):
    """Assemble the concept shape out of primitives, in millimetres.

    Mirrors what buildAircraft() in components/parametric-uav-viewer.tsx puts on
    screen - an ellipsoid fuselage, a hub cylinder, arms radiating out, a disc
    per propeller, a motor stub and a battery box - but built at true mm scale
    rather than the viewer's SCALE = 0.01 display units, because the encoder
    feeds log(scale) to the model and absolute size drives performance.

    This is an approximation of the viewer, not a port of it. The question is
    whether a primitive shape can stand in for CAD at all, not whether Python
    and three.js agree pixel for pixel.
    """
    import trimesh

    parts = []

    length = max(float(summary["fuselageLength"]), 40.0)
    horizontal = max(float(summary["fuselageHorizontalDiameter"]), 40.0)
    vertical = max(float(summary["fuselageVerticalDiameter"]), 30.0)

    body = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
    body.apply_scale([length * 0.5, vertical * 0.5, horizontal * 0.5])
    parts.append(body)

    rotors = max(int(summary["numPropellers"]), 1)
    hub_radius = 0.25 * max(horizontal, length)
    hub = trimesh.creation.cylinder(radius=hub_radius, height=vertical * 0.45, sections=max(rotors * 2, 12))
    hub.apply_translation([0, 0, vertical * 0.35])
    parts.append(hub)

    arm_length = float(summary.get("meanArmLength") or summary.get("armLength") or 300.0)
    arm_radius = max(hub_radius * 0.09, 6.0)
    prop_radius = propeller_diameter_mm(showcase.get("propeller")) * 0.5

    for index in range(rotors):
        angle = 2.0 * np.pi * index / rotors
        direction = np.array([np.cos(angle), np.sin(angle), 0.0])
        start = direction * hub_radius * 0.8
        end = direction * (hub_radius * 0.8 + arm_length)

        arm = trimesh.creation.cylinder(radius=arm_radius, segment=[start, end], sections=12)
        parts.append(arm)

        motor = trimesh.creation.cylinder(radius=arm_radius * 2.4, height=arm_radius * 5.0, sections=16)
        motor.apply_translation(end + np.array([0, 0, arm_radius * 2.5]))
        parts.append(motor)

        disc = trimesh.creation.cylinder(radius=prop_radius, height=arm_radius * 0.6, sections=48)
        disc.apply_translation(end + np.array([0, 0, arm_radius * 5.5]))
        parts.append(disc)

    battery = trimesh.creation.box(
        extents=[length * 0.55, horizontal * 0.30, vertical * 0.45]
    )
    battery.apply_translation([0, 0, -vertical * 0.15])
    parts.append(battery)

    wings = int(summary["numWings"])
    if wings > 0:
        span_each = max(float(summary["totalWingSpan"]) / wings, 50.0)
        chord = max(float(summary["meanWingChord"]), 40.0)
        for index in range(wings):
            angle = 2.0 * np.pi * index / wings
            panel = trimesh.creation.box(extents=[chord, span_each, max(chord * 0.12, 6.0)])
            panel.apply_transform(trimesh.transformations.rotation_matrix(angle, [0, 0, 1]))
            offset = np.array([np.cos(angle), np.sin(angle), 0.0]) * (span_each * 0.5 + hub_radius)
            panel.apply_translation(offset + np.array([0, 0, vertical * 0.1]))
            parts.append(panel)

    return trimesh.util.concatenate(parts)


def sample(mesh, seed: int) -> np.ndarray:
    import trimesh

    points, _ = trimesh.sample.sample_surface(mesh, N_POINTS, seed=seed)
    return np.asarray(points, dtype=np.float32)[None]


def relative_gap(a: float, b: float) -> float:
    denominator = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / denominator


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args(argv)

    needed = ["pointnet-geometry-v1.onnx", "trim-encoder-v1.onnx", "trim-head-v1.onnx"]
    if any(not (RUNS / name).is_file() for name in needed):
        print(MISSING)
        return 2
    try:
        import onnxruntime
        import trimesh
    except ImportError as exc:
        print(f"missing dependency: {exc.name}\n  pip install onnxruntime trimesh")
        return 2

    provider = ["CPUExecutionProvider"]
    geometry = onnxruntime.InferenceSession(str(RUNS / needed[0]), providers=provider)
    encoder = onnxruntime.InferenceSession(str(RUNS / needed[1]), providers=provider)
    head = onnxruntime.InferenceSession(str(RUNS / needed[2]), providers=provider)
    speeds = np.arange(51, dtype=np.float32)[None]

    index = json.loads((DATA / "design-index.json").read_text(encoding="utf-8"))
    by_id = {int(row["id"]): row for row in index["designs"]}
    showcase = json.loads((DATA / "showcase-designs.json").read_text(encoding="utf-8"))

    def predict(points: np.ndarray) -> dict:
        mass, distance = geometry.run(None, {"points_mm": points})[0][0]
        features = encoder.run(None, {"points_mm": points})[0]
        trim, valid = head.run(None, {"design_features": features, "speed": speeds})
        return {
            "mass": float(mass),
            "max_distance": float(distance),
            "trim": trim[0],
            "valid_probability": valid[0],
        }

    rows = []
    for key in sorted(showcase, key=int):
        design_id = int(key)
        summary = by_id[design_id]
        entry = showcase[key]

        stl = trimesh.load_mesh(MODELS / f"design-{design_id}.stl", process=False, force="mesh")
        concept = build_concept_mesh(summary, entry)

        seeds = [design_seed(design_id) + offset for offset in range(args.repeats)]
        stl_runs = [predict(sample(stl, seed)) for seed in seeds]
        concept_runs = [predict(sample(concept, seed)) for seed in seeds]

        def mean_of(runs, field):
            return float(np.mean([run[field] for run in runs]))

        record = {
            "design_id": design_id,
            "rotors": int(summary["numPropellers"]),
            "wings": int(summary["numWings"]),
            "stl_faces": int(len(stl.faces)),
            "concept_faces": int(len(concept.faces)),
            "extent_gap_pct": {},
            "scalar": {},
            "trim": {},
        }

        stl_extent = stl.bounds[1] - stl.bounds[0]
        concept_extent = concept.bounds[1] - concept.bounds[0]
        record["extent_gap_pct"] = {
            axis: round(100 * relative_gap(float(stl_extent[i]), float(concept_extent[i])), 1)
            for i, axis in enumerate("xyz")
        }

        for field in ("mass", "max_distance"):
            a = mean_of(stl_runs, field)
            b = mean_of(concept_runs, field)
            record["scalar"][field] = {
                "stl": round(a, 4),
                "concept": round(b, 4),
                "gap_pct": round(100 * relative_gap(a, b), 1),
            }

        valid_speeds = [row["speed"] for row in entry["trim"] if row["valid"]]
        for position, name in enumerate(TRIM_TARGETS):
            a = np.mean([run["trim"][:, position] for run in stl_runs], axis=0)
            b = np.mean([run["trim"][:, position] for run in concept_runs], axis=0)
            scored = np.array(valid_speeds, dtype=int) if valid_speeds else np.arange(51)
            gaps = [relative_gap(float(a[s]), float(b[s])) for s in scored]
            record["trim"][name] = {
                "median_gap_pct": round(100 * float(np.median(gaps)), 1),
                "max_gap_pct": round(100 * float(np.max(gaps)), 1),
            }

        rows.append(record)

    scalar_gaps = [r["scalar"]["max_distance"]["gap_pct"] for r in rows]
    mass_gaps = [r["scalar"]["mass"]["gap_pct"] for r in rows]
    trim_medians = {
        name: float(np.median([r["trim"][name]["median_gap_pct"] for r in rows]))
        for name in TRIM_TARGETS
    }

    resample_reference = None
    variance_path = REPO_ROOT / "ml" / "reports" / "sampling_variance.json"
    if variance_path.is_file():
        variance = json.loads(variance_path.read_text(encoding="utf-8"))
        per_design = variance.get("per_design", {})
        resample_reference = round(
            float(np.median([v["dist_cv_pct"] for v in per_design.values()])), 1
        )

    median_distance_gap = float(np.median(scalar_gaps))
    verdict = (
        "concept shape is usable"
        if resample_reference and median_distance_gap <= 2 * resample_reference
        else "concept shape is NOT a drop-in for the STL"
    )

    report = {
        "question": (
            "Can the browser's primitive concept shape replace cadfile.stl as "
            "model input, so that edited designs can be predicted at all?"
        ),
        "why_it_matters": (
            "Dataset designs already have answers in trims.npy. The model is only "
            "needed for designs the user just edited, and those have no STL."
        ),
        "method": (
            "Rebuild the concept shape in millimetres from the same DesignDraft "
            "parameters the viewer uses, sample both meshes the same way with the "
            "same seeds, and compare predictions. The Python build approximates "
            "components/parametric-uav-viewer.tsx; it is not a port of it."
        ),
        "yardstick": {
            "resampling_spread_median_pct": resample_reference,
            "source": "ml/reports/sampling_variance.json",
            "rule": (
                "Reseeding the sampler alone already moves Max_Distance by this "
                "much. A concept gap within about twice that is inside the noise "
                "the model already carries."
            ),
        },
        "summary": {
            "designs": len(rows),
            "repeats_per_design": args.repeats,
            "mass_gap_median_pct": round(float(np.median(mass_gaps)), 1),
            "max_distance_gap_median_pct": round(median_distance_gap, 1),
            "max_distance_gap_worst_pct": round(float(np.max(scalar_gaps)), 1),
            "trim_median_gap_pct": {k: round(v, 1) for k, v in trim_medians.items()},
        },
        "verdict": verdict,
        "caveats": [
            "The Python concept shape approximates the viewer, so part of the gap "
            "is the approximation rather than the concept representation itself.",
            "Primitives overlap, so interior surfaces get sampled; a CAD outer "
            "surface does not have that.",
            "Twelve showcase designs is a small sample and they are not a random "
            "draw from the dataset.",
        ],
        "per_design": rows,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"wrote {args.out.relative_to(REPO_ROOT)}")
    print(f"  {len(rows)} designs, {args.repeats} samplings each")
    print(f"  yardstick: reseeding alone moves Max_Distance by {resample_reference}% (median)")
    print()
    print(f"  {'design':>7} {'rotors':>6} {'faces stl':>10} {'concept':>8} "
          f"{'Mass gap':>9} {'Dist gap':>9}")
    for row in rows:
        print(
            f"  {row['design_id']:>7} {row['rotors']:>6} {row['stl_faces']:>10,} "
            f"{row['concept_faces']:>8,} {row['scalar']['mass']['gap_pct']:>8.1f}% "
            f"{row['scalar']['max_distance']['gap_pct']:>8.1f}%"
        )
    print()
    print(f"  median Mass gap          {report['summary']['mass_gap_median_pct']:.1f}%")
    print(f"  median Max_Distance gap  {report['summary']['max_distance_gap_median_pct']:.1f}%")
    print(f"  worst Max_Distance gap   {report['summary']['max_distance_gap_worst_pct']:.1f}%")
    print()
    print("  trim curve median gap over each design's valid speeds")
    for name, value in trim_medians.items():
        print(f"    {name:>12} {value:6.1f}%")
    print()
    print(f"  VERDICT: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
