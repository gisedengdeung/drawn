"""Bounded geometry optimization and AircraftVerse ranking.

Compatibility port of lib/agent/optimization.ts and lib/candidate-search.ts.
Model inference remains separate from Neighbor Estimate v1.
"""
from __future__ import annotations

import copy
import math
from urllib.parse import quote

from pyuca import Collator

from ..core.errors import ApiError
from .draft import finite
from .estimate import estimate_draft, positive

OBJECTIVES = ("range", "hover", "power", "drag", "speed", "balanced")
MAX_DRAFT_EVALUATIONS = 64
_GROUPS = ("structure", "fuselage", "wing", "energy", "propulsion", "payload", "layout")
_COLLATOR = Collator()


def _error(message, code="invalid_optimization"):
    return ApiError(422, code, message)


def _limits(options):
    objective = options.get("objective")
    if objective not in OBJECTIVES:
        raise _error("지원하지 않는 최적화 목표입니다.")
    mass = options.get("massLimit")
    power = options.get("powerLimit")
    mass = 100000 if mass is None else mass
    power = 1000000 if power is None else power
    if not positive(mass) or not positive(power):
        raise _error("질량·전력 한도는 양수여야 합니다.")
    return mass, power


def build_candidate_pool(designs, current_id, mass_limit, power_limit, objective):
    key = {"hover": "hoverTime", "drag": "dragAt20", "speed": "maxSpeed"}.get(objective, "maxDistance")
    return [
        design for design in designs
        if design["id"] != current_id
        and design.get("feasible")
        and positive(design.get("mass")) and design["mass"] <= mass_limit
        and positive(design.get("power")) and design["power"] <= power_limit
        and positive(design.get(key))
    ]


def _pareto_knee(designs):
    ordered = sorted(designs, key=lambda d: (d["power"], d["mass"], -d["maxDistance"], d["id"]))
    front = []

    def dominates(left, right):
        return left["power"] <= right["power"] and left["mass"] <= right["mass"] and left["maxDistance"] >= right["maxDistance"]

    for design in ordered:
        if any(dominates(candidate, design) for candidate in front):
            continue
        front = [candidate for candidate in front if not dominates(design, candidate)]
        front.append(design)
    if not front:
        return []
    bounds = {key: (min(d[key] for d in front), max(d[key] for d in front)) for key in ("maxDistance", "power", "mass")}

    def score(design):
        normalized = {key: (design[key] - lower) / max(upper - lower, 1) for key, (lower, upper) in bounds.items()}
        distance = math.hypot(1 - normalized["maxDistance"], normalized["power"], normalized["mass"])
        return 1 / (1 + distance)

    return sorted(({**design, "score": score(design)} for design in front), key=lambda d: (-d["score"], d["id"]))


def rank_candidates(pool, objective, limit=3):
    if objective == "balanced":
        return _pareto_knee(pool)[:limit]
    key = {"range": "maxDistance", "hover": "hoverTime", "power": "power", "drag": "dragAt20", "speed": "maxSpeed"}[objective]
    maximum = max([1] + [design[key] for design in pool])

    def score(design):
        if objective == "drag" and not design[key]:
            return 0
        normalized = design[key] / maximum
        return 1 - normalized if objective in ("power", "drag") else normalized

    return sorted(({**design, "score": score(design)} for design in pool), key=lambda d: (-d["score"], d["id"]))[:limit]


def recommend_dataset_candidates(designs, selected, options):
    mass_limit, power_limit = _limits(options)
    topology_locked = options.get("topologyLocked")
    topology_locked = True if topology_locked is None else topology_locked
    objective = options["objective"]
    pool = [
        design for design in build_candidate_pool(designs, selected["id"], mass_limit, power_limit, objective)
        if not topology_locked or design["hub"] == selected["hub"]
    ]
    return {
        "source": "dataset",
        "objective": objective,
        "candidateCount": len(pool),
        "candidates": rank_candidates(pool, objective, 3),
        "constraints": {
            "massLimit": mass_limit, "powerLimit": power_limit,
            "topologyLocked": topology_locked, "topology": selected["hub"] if topology_locked else None,
        },
        "assumptions": [
            "AircraftVerse 시뮬레이션 KPI로 순위를 계산했습니다.",
            "후보 선택은 다른 기준 설계를 여는 동작입니다. 현재 설계의 일부 변경과 구분합니다.",
            "feasible은 원본 최대 비행거리가 양수라는 뜻이며 제작·비행 안전 판정이 아닙니다.",
        ],
    }


def _encoded_id(value):
    return quote(value, safe="-_.!~*'()")


def list_editable_parameters(draft, baseline=None):
    baseline = draft if baseline is None else baseline
    parameters = []

    def add(parameter_id, path, label, group, value, original, minimum, maximum):
        if not positive(value) or not positive(original):
            return
        definitions = [
            definition for definition in draft.get("parameterDefinitions", [])
            if definition.get("path") == path or definition.get("id") == parameter_id
        ]
        if any(not definition.get("editable") for definition in definitions):
            return
        lower = max(0.001, min(minimum, math.floor(original), math.floor(value)))
        upper = max(maximum, math.ceil(original), math.ceil(value))
        for definition in definitions:
            bound = definition.get("range")
            if bound:
                if not finite(bound.get("min")) or not finite(bound.get("max")):
                    return
                lower, upper = max(lower, bound["min"]), min(upper, bound["max"])
            if definition.get("min") is not None:
                if not finite(definition["min"]):
                    return
                lower = max(lower, definition["min"])
            if definition.get("max") is not None:
                if not finite(definition["max"]):
                    return
                upper = min(upper, definition["max"])
        if not finite(lower) or not finite(upper) or lower > upper or value < lower or value > upper:
            return
        parameters.append({
            "id": parameter_id, "path": path, "label": label, "group": group,
            "unit": "mm", "value": value, "min": lower, "max": upper, "step": 1,
        })

    for key, label, minimum, maximum in [
        ("length", "동체 길이", 84, 559),
        ("horizontalDiameter", "동체 수평 직경", 120, 805),
        ("verticalDiameter", "동체 수직 직경", 51, 354),
    ]:
        add(f"fuselage:{key}", f"fuselage.{key}", label, "fuselage", draft["fuselage"][key], baseline["fuselage"][key], minimum, maximum)
    if len({segment["id"] for segment in draft["segments"]}) == len(draft["segments"]):
        originals = {segment["id"]: segment for segment in baseline["segments"]}
        for index, segment in enumerate(draft["segments"]):
            original = originals.get(segment["id"])
            if original:
                add(f"segment:{_encoded_id(segment['id'])}:length", f"segments.{index}.length", f"Arm {index + 1} 길이",
                    "structure", segment["length"], original["length"], 50, 520)
    if len({wing["id"] for wing in draft["wings"]}) == len(draft["wings"]):
        originals = {wing["id"]: wing for wing in baseline["wings"]}
        for index, wing in enumerate(draft["wings"]):
            original = originals.get(wing["id"])
            if not original:
                continue
            for key, label, minimum, maximum in [
                ("span", "스팬", 200, 2000), ("chordInner", "안쪽 시위", 100, 500),
                ("chordOuter", "바깥 시위", 50, max(50, wing["chordInner"])),
            ]:
                add(f"wing:{_encoded_id(wing['id'])}:{key}", f"wings.{index}.{key}", f"날개 {index + 1} {label}",
                    "wing", wing[key], original[key], minimum, maximum)
    return parameters


def _locked(parameter, locks, draft, parameters):
    for identifier in locks:
        if identifier in ("all", "*", parameter["id"], parameter["path"], parameter["group"]):
            return True
        if identifier in _GROUPS or any(identifier in (entry["id"], entry["path"]) for entry in parameters):
            continue
        definition = next((entry for entry in draft.get("parameterDefinitions", []) if entry["id"] == identifier), None)
        # Unmapped raw locks conservatively protect a complete group, or all groups if unknown.
        if definition is None or definition["group"] == parameter["group"]:
            return True
    return False


def _write_parameter(draft, parameter, value):
    parts = parameter["path"].split(".")
    if len(parts) == 2 and parts[0] == "fuselage" and parts[1] in ("length", "horizontalDiameter", "verticalDiameter"):
        draft["fuselage"][parts[1]] = value
    elif len(parts) == 3 and parts[0] == "segments" and parts[2] == "length":
        draft["segments"][int(parts[1])]["length"] = value
    elif len(parts) == 3 and parts[0] == "wings" and parts[2] in ("span", "chordInner", "chordOuter"):
        draft["wings"][int(parts[1])][parts[2]] = value
    else:
        raise _error("지원하지 않는 변경 대상입니다.", "invalid_proposal")
    for definition in draft.get("parameterDefinitions", []):
        if definition.get("path") == parameter["path"] or definition.get("id") == parameter["id"]:
            definition["value"] = value


def apply_draft_changes(draft, changes, baseline=None, locks=None):
    baseline = draft if baseline is None else baseline
    locks = [] if locks is None else locks
    if not isinstance(changes, list) or not 1 <= len(changes) <= 12:
        raise _error("변경은 1~12개만 적용할 수 있습니다.", "invalid_proposal")
    parameters = list_editable_parameters(draft, baseline)
    by_id = {parameter["id"]: parameter for parameter in parameters}
    seen = set()
    next_draft = copy.deepcopy(draft)
    for change in changes:
        parameter = by_id.get(change.get("id")) if isinstance(change, dict) else None
        if parameter is None or change["id"] in seen or _locked(parameter, locks, draft, parameters):
            raise _error("잠겼거나 지원하지 않는 변경 대상입니다.", "invalid_proposal")
        seen.add(change["id"])
        if change.get("unit") != "mm" or not finite(change.get("before")) or change["before"] != parameter["value"]:
            raise _error("현재 값과 변경안의 기준 값이 다릅니다. 다시 계산해 주세요.", "invalid_proposal")
        after = change.get("after")
        if (not positive(after) or after < parameter["min"] or after > parameter["max"]
            or abs(after - parameter["value"]) > parameter["value"] * 0.100001 or after == parameter["value"]):
            raise _error("허용 범위 또는 ±10% 변경 한도를 벗어났습니다.", "invalid_proposal")
        _write_parameter(next_draft, parameter, after)
    originals = {wing["id"]: wing for wing in draft["wings"]}
    for wing in next_draft["wings"]:
        previous = originals.get(wing["id"])
        if previous is None or (wing["chordInner"] == previous["chordInner"] and wing["chordOuter"] == previous["chordOuter"]):
            continue
        maximum_ratio = max(1, previous["chordOuter"] / previous["chordInner"])
        if wing["chordOuter"] / wing["chordInner"] > maximum_ratio + 1e-9:
            raise _error("새 역테이퍼를 만들거나 기존 역테이퍼 비율을 증가시키는 변경은 지원하지 않습니다.", "invalid_proposal")
    return next_draft


def _improvement(before, after, objective):
    if objective == "balanced":
        if not all(positive(value[key]) for value in (before, after) for key in ("range", "power", "mass")):
            return None
        if after["range"] < before["range"] or after["power"] > before["power"] or after["mass"] > before["mass"]:
            return None
        return ((after["range"] / before["range"] - 1) + (1 - after["power"] / before["power"]) + (1 - after["mass"] / before["mass"])) / 3
    key = "maxSpeed" if objective == "speed" else objective
    if not positive(before.get(key)) or not positive(after.get(key)):
        return None
    return (after[key] - before[key]) / before[key] * (-1 if objective in ("power", "drag") else 1)


def optimize_draft(selected, baseline, draft, designs, **options):
    mass_limit, power_limit = _limits(options)
    objective = options["objective"]
    if selected["id"] != baseline["baselineId"] or selected["id"] != draft["baselineId"]:
        raise _error("설계 기준이 일치하지 않습니다.")
    baseline_estimate = estimate_draft(selected, baseline, baseline, designs)
    current_estimate = estimate_draft(selected, draft, baseline, designs)
    parameters = list_editable_parameters(draft, baseline)
    result = {
        "source": "neighbor-estimate",
        "baselineEstimate": baseline_estimate,
        "currentEstimate": current_estimate,
        "parameters": parameters, "proposals": [], "evaluatedCount": 0, "reason": "",
        "assumptions": [
            "각 변경안은 한 개의 형상 변수만 현재 값 대비 ±5% 또는 ±10% 범위에서 탐색합니다.",
            "부품·배터리·탑재량·topology는 변경하지 않습니다. 치수와 부품의 실제 간섭·호환성은 검증하지 않습니다.",
            "결과는 인접 설계 추정에 따른 비교안이며 실제 성능 개선이나 전역 최적해가 아닙니다.",
            "균형형 Draft 제안은 거리 감소·전력 증가·질량 증가가 없는 경우만 제시합니다.",
        ],
    }
    if any(draft[key] != baseline[key] for key in ("topology", "numPropellers", "numWings")):
        result["reason"] = "topology 또는 추진기·날개 개수가 바뀐 설계는 지원하지 않습니다."
        return result
    if not designs or not all(positive(current_estimate[key]) for key in ("mass", "power")) or _improvement(current_estimate, current_estimate, objective) is None:
        result["reason"] = "비교에 필요한 유효한 기준 성능 또는 이웃 데이터가 부족합니다."
        return result
    locks = options.get("lockedParameterIds") or []
    unlocked = [parameter for parameter in parameters if not _locked(parameter, locks, draft, parameters)]
    queues = [[parameter for parameter in unlocked if parameter["group"] == group] for group in ("fuselage", "structure", "wing")]
    ordered = []
    while any(queues) and len(ordered) < MAX_DRAFT_EVALUATIONS / 4:
        for queue in queues:
            if queue:
                ordered.append(queue.pop(0))
    seen = set()
    for parameter in ordered:
        for ratio in (-0.1, -0.05, 0.05, 0.1):
            if result["evaluatedCount"] >= MAX_DRAFT_EVALUATIONS:
                break
            after_value = math.floor(parameter["value"] * (1 + ratio) + 0.5)
            key = f"{parameter['id']}:{after_value}"
            if key in seen:
                continue
            seen.add(key)
            change = {
                "id": parameter["id"], "label": parameter["label"],
                "before": parameter["value"], "after": after_value, "unit": "mm",
            }
            try:
                candidate = apply_draft_changes(draft, [change], baseline, locks)
            except ApiError:
                continue
            result["evaluatedCount"] += 1
            after = estimate_draft(selected, candidate, baseline, designs)
            if not all(positive(after[name]) for name in ("mass", "power")) or after["mass"] > mass_limit or after["power"] > power_limit:
                continue
            gain = _improvement(current_estimate, after, objective)
            if gain is None or gain <= 1e-6:
                continue
            result["proposals"].append({
                "id": f"draft:{key}", "changes": [change], "before": current_estimate,
                "after": after, "improvement": gain, "source": "neighbor-estimate",
            })
    result["proposals"].sort(key=lambda proposal: (-proposal["improvement"], _COLLATOR.sort_key(proposal["id"])))
    result["proposals"] = result["proposals"][:3]
    result["reason"] = (
        "현재 설계보다 목표 지표가 개선되는 추정안을 찾았습니다." if result["proposals"]
        else "허용 범위·잠금·제약 안에서 더 나은 추정안을 찾지 못했습니다." if unlocked
        else "탐색 가능한 형상 변수가 모두 잠겨 있습니다."
    )
    return result
