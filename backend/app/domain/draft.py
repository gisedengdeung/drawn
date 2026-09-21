"""Canonical draft hydration, validation and legacy browser fingerprints."""
from __future__ import annotations
import copy
import json
import math
import re
from pyuca import Collator
import rfc8785
from ..core.errors import ApiError

_COLLATOR = Collator()
def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def canonical(value):
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(str(k), ensure_ascii=False) + ":" + canonical(value[k]) for k in sorted(value, key=_COLLATOR.sort_key)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    return rfc8785.dumps(value).decode("utf-8")

def stable_hash(text):
    first, second = 0x811c9dc5, 0x9e3779b9
    raw = text.encode("utf-16-le", errors="surrogatepass")
    for pos in range(0, len(raw), 2):
        char = raw[pos] | (raw[pos + 1] << 8)
        first = ((first ^ char) * 0x01000193) & 0xffffffff
        second = ((second ^ char) * 0x5bd1e995) & 0xffffffff
    return f"{first:08x}{second:08x}"

def fingerprint(draft):
    return stable_hash(canonical(draft))

def _group(token):
    for pattern, group in [
        (r"cargo|payload|mass", "payload"), (r"wing|naca|aileron|flap|servo", "wing"),
        (r"battery.*(?:x|y)|sensor|autopilot|current.*(?:x|y)|voltage.*(?:x|y)|gps|vario|rpm.*(?:x|y)", "layout"),
        (r"fuselage|diameter|floor|body_(?!rot)", "fuselage"), (r"motor|propeller|prop_|rpm", "propulsion"),
        (r"battery|capacity|voltage|current", "energy"),
    ]:
        if re.search(pattern, token): return group
    return "structure"

def _range(token, value):
    if not finite(value): return None
    if re.search(r"bias|ratio|taper.*offset", token): return {"min": 0, "max": 1}
    if re.search(r"angle|rotation|_rot|clock", token): return {"min": min(-180, math.floor(value)), "max": max(360, math.ceil(value))}
    if re.search(r"length|span|chord|diameter|height", token): return {"min": 0, "max": max(math.ceil(value * 2), math.ceil(value), 10)}
    if re.search(r"offset|(?:^|_)[xy](?:_|$)", token):
        extent = max(math.ceil(abs(value) * 2), 300)
        return {"min": -extent, "max": extent}
    if re.search(r"mass|cargo|payload|load", token): return {"min": 0, "max": max(math.ceil(value * 2), 20)}
    extent = max(abs(value), 1)
    return {"min": math.floor(value - extent), "max": math.ceil(value + extent)}

def hydrate_draft(raw):
    draft = copy.deepcopy(raw)
    if draft.get("parameterDefinitions") or not draft.get("sourceParameters"): return draft
    definitions = []
    for index, entry in enumerate(draft["sourceParameters"]):
        name, value, optimization, target_count = entry
        token = (name + " " + (optimization or "")).lower()
        group = _group(token)
        unit = None
        if re.search(r"angle|rotation|_rot|clock", token): unit = "°"
        elif re.search(r"mass|cargo|payload|load", token): unit = "g" if re.search(r"wing.*load", token) else "kg"
        elif re.search(r"length|span|chord|offset|diameter|height|(?:^|_)[xy](?:_|$)", token): unit = "mm"
        step = None
        if finite(value):
            step = 0.01 if re.search("bias|ratio", name, re.I) else 0.1 if re.search("mass", name, re.I) or (abs(value) < 10 and int(value) != value) else 1
        definitions.append({
            "id": "parameter:" + re.sub(r"[^a-zA-Z0-9]+", "-", name).strip("-") + ":" + str(index),
            "path": f"lowLevel.parameters.{index}", "label": name, "group": group, "unit": unit,
            "range": _range(token, value), "step": step, "baseline": value, "value": value,
            "optimization": optimization,
            "editable": not bool(re.search(r"CONTROLCHANNELAUTO|CONTROL_CHANNEL_AUTO|FIXEDROTATION", name, re.I)) and (finite(value) or isinstance(value, bool) or bool(re.search("NACA|PROFILE", name, re.I))),
            "advanced": not bool(optimization), "affectsGeometry": group in ("structure", "fuselage", "propulsion", "energy", "wing", "layout", "payload"),
            "affectsPerformance": bool(optimization) and group != "layout",
            "compatibility": f"{target_count} CAD component{'s' if target_count != 1 else ''} linked" if target_count else None,
        })
    draft["parameterDefinitions"] = definitions
    return draft

def _fail(code="invalid_draft", message="설계 데이터 형식을 확인해 주세요."):
    raise ApiError(400, code, message)

def _same(left, right):
    if left != right: _fail("invalid_structure", "원본 구성과 부품 연결 식별자는 변경할 수 없습니다.")

def _fields(value, baseline, names):
    for name in names: _same(value.get(name), baseline.get(name))

def _number(value, baseline, bounds, definitions=(), pattern=None, match_value=False):
    lo, hi = min(bounds[0], math.floor(baseline)), max(bounds[1], math.ceil(baseline))
    if pattern:
        for definition in definitions:
            if not definition.get("editable") or not definition.get("range") or not finite(definition.get("value")): continue
            if not re.search(pattern, (definition["label"] + " " + (definition.get("optimization") or "")).upper()): continue
            base = definition.get("baseline")
            if match_value and (not finite(base) or abs(base-baseline) > max(.02, abs(base)*.0001)): continue
            lo, hi = min(lo, definition["range"]["min"]), max(hi, definition["range"]["max"])
    if not finite(value) or not lo <= value <= hi:
        _fail("out_of_range", "편집 값이 원본 기준 허용 범위를 벗어났습니다.")
    return value

def _choice(value, baseline, catalog):
    if value == baseline: return baseline
    if not isinstance(value, str) or value not in catalog: _fail("unknown_component", "서버 부품 카탈로그에 없는 모델 또는 프로파일입니다.")
    return value

def validate_draft(draft, raw_baseline, catalogs):
    try: return _validate_draft(draft, raw_baseline, catalogs)
    except (TypeError, KeyError, IndexError, AttributeError, OverflowError, ValueError):
        _fail()

def _validate_draft(draft, raw_baseline, catalogs):
    if not isinstance(draft, dict): _fail()
    baseline = hydrate_draft(raw_baseline)
    if not isinstance(draft.get("name"), str) or not 0 < len(draft["name"]) <= 240: _fail()
    _fields(draft, baseline, ("baselineId", "topology", "numPropellers", "numWings", "physicalComponents", "nodes", "sourceParameters"))
    _same(draft["energy"]["configuration"], baseline["energy"]["configuration"])
    for key in ("segments", "propulsionGroups", "wings"):
        if not isinstance(draft[key], list): _fail()
        _same(len(draft[key]), len(baseline[key]))
    _same(len(draft["energy"]["batteryTypes"]), len(baseline["energy"]["batteryTypes"]))
    _same(set(draft["layout"]), set(baseline["layout"]))
    definitions = baseline.get("parameterDefinitions", [])
    supplied = {}
    known = {d["id"] for d in definitions}
    for item in draft["parameterDefinitions"]:
        if item["id"] not in known or item["id"] in supplied: _fail("invalid_parameter", "중복되거나 원본에 없는 변수입니다.")
        supplied[item["id"]] = item
    if supplied and len(supplied) != len(known): _fail("invalid_parameter", "원본 변수 목록이 누락되었습니다.")
    result = copy.deepcopy(baseline)
    result["name"] = draft["name"]
    for definition in result.get("parameterDefinitions", []):
        value = supplied.get(definition["id"], {}).get("value", definition["value"])
        original = definition["value"]
        if type(value) is type(original) and value == original: continue
        if finite(value) and finite(original) and value == original: continue
        if not definition["editable"]: _fail("readonly_parameter", "읽기 전용 원본 변수는 변경할 수 없습니다.")
        if value is None or original is None or not ((finite(value) and finite(original)) or type(value) is type(original)):
            _fail("invalid_parameter_type", "원본 변수의 값 형식은 변경할 수 없습니다.")
        if finite(value):
            limits = definition.get("range")
            if not limits or not limits["min"] <= value <= limits["max"]: _fail("out_of_range", "원본 변수의 허용 범위를 벗어났습니다.")
        elif isinstance(value, str):
            if not re.search("NACA|PROFILE", definition["label"], re.I) or value not in catalogs["nacaProfiles"]: _fail("unknown_component")
        definition["value"] = value
    for index, segment in enumerate(draft["segments"]):
        source = baseline["segments"][index]
        _fields(segment, source, ("id", "path", "nodeType", "slot", "parentPath", "depth", "multiplicity", "parameters", "wing"))
        target = result["segments"][index]
        for key, limits, pattern in [
            ("length", (50,520), r"ARM_.*LENGTH|ROTATEDARM_.*LENGTH|ARM_LENGTH"),
            ("angle", (-135,360), r"CLOCK_ANGLE|ANGHORZCONN|ROT2|BODY_ROT_ANGLE"), ("offset",(-50,50),None),
        ]: target[key] = _number(segment[key], source[key], limits, definitions, pattern, True)
        for key, catalog in (("motorType", "motors"), ("propellerType", "propellers")):
            if key in segment or key in source: target[key] = _choice(segment.get(key), source.get(key), catalogs[catalog])
    for index, group in enumerate(draft["propulsionGroups"]):
        source = baseline["propulsionGroups"][index]
        _fields(group, source, ("id","path","segmentId","motorInstance","propellerInstance"))
        for key, catalog in (("motorType","motors"),("propellerType","propellers")):
            result["propulsionGroups"][index][key] = _choice(group[key],source[key],catalogs[catalog])
    result["energy"]["batteryTypes"] = [_choice(v, baseline["energy"]["batteryTypes"][i], catalogs["batteries"]) for i,v in enumerate(draft["energy"]["batteryTypes"])]
    for key, limits, pattern in [
        ("length",(84,559),r"^FUSELAGE_LENGTH(?:\s|$)"),
        ("horizontalDiameter",(120,805),r"^FUSELAGE_(?:HORZ|HORIZONTAL)_DIAMETER(?:\s|$)"),
        ("verticalDiameter",(51,354),r"^FUSELAGE_(?:VERT|VERTICAL)_DIAMETER(?:\s|$)"),
        ("floorHeight",(8,60),r"^FUSELAGE_FLOOR_HEIGHT(?:\s|$)"),
    ]: result["fuselage"][key] = _number(draft["fuselage"][key],baseline["fuselage"][key],limits,definitions,pattern)
    result["payload"]["mass"] = _number(draft["payload"]["mass"],baseline["payload"]["mass"],(0,20),definitions,r"^(?:CARGOMASS|CARGO_MASS)(?:\s|$)")
    for index, wing in enumerate(draft["wings"]):
        source, target = baseline["wings"][index], result["wings"][index]
        _fields(wing,source,("id","path","type","taperOffset","load"))
        for key,catalog in (("nacaProfile","nacaProfiles"),("servoType","servos")):
            if key in wing or key in source: target[key] = _choice(wing.get(key),source.get(key),catalogs[catalog])
        for key, limits, pattern in [
            ("span",(200,2000),r"WING_.*SPAN"),("chordInner",(100,500),r"WING_.*CHORD.*(?:1|INNER)"),
            ("chordOuter",(50,max(50,wing["chordInner"])),r"WING_.*CHORD.*(?:2|OUTER)"),
            ("rotation",(0,360),r"WING_.*(?:TUBE_)?ROT"),("tubeOffset",(-100,160),r"WING_.*TUBE_OFFSET"),
            ("aileronBias",(.1,1),r"WING_.*AILERON"),("flapBias",(.1,1),r"WING_.*FLAP"),
        ]: target[key] = _number(wing[key],source[key],limits,definitions,pattern,True)
    for key in baseline["layout"]:
        for axis in ("x","y"): result["layout"][key][axis] = _number(draft["layout"][key][axis],baseline["layout"][key][axis],(-280,280))
    return result


def is_design_draft(value):
    """Structural guard matching the browser's gallery snapshot contract."""
    record = lambda v: isinstance(v, dict)
    text = lambda v: isinstance(v, str) and len(v.encode("utf-16-le", errors="surrogatepass")) // 2 <= 2000
    number = lambda v: finite(v) and abs(v) <= 1e9
    scalar = lambda v: v is None or text(v) or number(v) or isinstance(v, bool)
    def fields(v, strings=(), numbers=()):
        return record(v) and all(text(v.get(k)) for k in strings) and all(number(v.get(k)) for k in numbers)
    def items(v, check):
        return isinstance(v, list) and len(v) <= 5000 and all(check(x) for x in v)
    def params(v):
        return record(v) and all(scalar(x) for x in v.values())
    def wing(v):
        return fields(v, ('id','path','type','nacaProfile'), ('span','chordInner','chordOuter','rotation','aileronBias','flapBias','load','tubeOffset')) and isinstance(v.get('taperOffset'),bool)
    def segment(v):
        return fields(v, ('id','path','nodeType','slot'), ('depth','multiplicity','length','angle','offset')) and 'parentPath' in v and (v['parentPath'] is None or text(v['parentPath'])) and params(v.get('parameters')) and (v.get('wing') is None or v.get('wing') is False or v.get('wing') == 0 or v.get('wing') == '' or wing(v.get('wing')))
    def definition(v):
        return fields(v, ('id','path','label','group')) and 'value' in v and scalar(v['value']) and 'baseline' in v and scalar(v['baseline']) and 'range' in v and (v['range'] is None or fields(v['range'], numbers=('min','max')))
    if not fields(value, ('name','topology'), ('baselineId','numPropellers','numWings')):
        return False
    if int(value['baselineId']) != value['baselineId'] or not 1 <= value['baselineId'] <= 28080:
        return False
    if not 0 <= value['numPropellers'] <= 100 or not 0 <= value['numWings'] <= 100:
        return False
    return (items(value.get('nodes'), lambda v: fields(v, ('id','path','nodeType','slot')) and params(v.get('parameters')))
        and items(value.get('segments'), segment)
        and items(value.get('propulsionGroups'), lambda v: fields(v, ('id','path','segmentId','motorType','propellerType')))
        and items(value.get('parameterDefinitions'), definition)
        and items(value.get('sourceParameters'), lambda v: isinstance(v,list) and len(v)==4 and text(v[0]) and scalar(v[1]) and (v[2] is None or text(v[2])) and number(v[3]))
        and record(value.get('physicalComponents')) and all(items(value['physicalComponents'].get(k), lambda v: fields(v, ('instance','type','choice'))) for k in ('motors','propellers','batteries','wings','servos'))
        and fields(value.get('energy'), ('configuration',)) and items(value['energy'].get('batteryTypes'), text)
        and fields(value.get('fuselage'), numbers=('length','horizontalDiameter','verticalDiameter','floorHeight'))
        and items(value.get('wings'), wing) and fields(value.get('payload'), numbers=('mass',))
        and record(value.get('layout')) and all(fields(v,numbers=('x','y')) for v in value['layout'].values()))
