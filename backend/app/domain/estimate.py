"""Neighbor Estimate v1, separate from the trained conditional MLP."""
import math
import re
from .draft import finite
def _js_sum(values):
    # Python 3.12+ sum compensates floats; preserve JavaScript reduce ordering.
    total = 0
    for value in values:
        total += value
    return total

def positive(v): return finite(v) and v > 0
def average(xs, default): return _js_sum(xs)/len(xs) if xs else default
def clamp(v,a,b): return max(a,min(b,v))
def _battery(xs):
    m=re.search(r"(\d{3,6})mAh",xs[0] if xs else "",re.I)
    return int(m.group(1)) if m else 5000
def count_changes(a,b):
    def count(x,y):
        if isinstance(x,dict) and isinstance(y,dict): return _js_sum(count(x.get(k),y.get(k)) for k in x.keys()|y.keys())
        if isinstance(x,list) and isinstance(y,list): return _js_sum(count(x[i] if i<len(x) else None,y[i] if i<len(y) else None) for i in range(max(len(x),len(y))))
        return int(x!=y or isinstance(x,bool)!=isinstance(y,bool))
    structure=count({**a,"parameterDefinitions":[]},{**b,"parameterDefinitions":[]})
    defs=b.get("parameterDefinitions",[])
    raw=_js_sum(v.get("value")!=(defs[i].get("value") if i<len(defs) else None) for i,v in enumerate(a.get("parameterDefinitions",[])))
    return max(structure,raw)
def estimate_draft(selected,draft,baseline,designs):
    if count_changes(draft,baseline)==0:
        return dict(mass=selected["mass"],range=selected["maxDistance"],hover=selected["hoverTime"],maxSpeed=selected["maxSpeed"],power=selected["power"],drag=selected["dragAt20"],similarity=100,closestId=selected["id"],source="dataset",modelVersion="neighbor-estimate-v1",neighbors=[dict(designId=selected["id"],distance=0,weight=1)],topologyFallbackUsed=False,appliedCorrections={},assumptions=["Unchanged draft: original AircraftVerse simulation KPIs."],unsupportedInputs=[])
    mean_arm=average([s["length"] for s in draft["segments"]],selected.get("meanArmLength") or selected["armLength"] or 300)
    wing_span=_js_sum(w["span"] for w in draft["wings"])
    wing_chord=average([(w["chordInner"]+w["chordOuter"])*.5 for w in draft["wings"]],0)
    groups=draft["propulsionGroups"]; motor=groups[0]["motorType"] if groups else ""; propeller=groups[0]["propellerType"] if groups else ""
    batteries=draft["energy"]["batteryTypes"]; battery=batteries[0] if batteries else ""
    same=[d for d in designs if d["hub"]==draft["topology"]]
    candidates=same if len(same)>=8 else [d for d in designs if d["numPropellers"]==selected["numPropellers"] and bool(d["numWings"]>0)==bool(draft["wings"])]
    neighbors=[]
    for d in candidates:
        distance=_js_sum(abs(a-b)/size*weight if finite(a) and finite(b) else 0 for a,b,size,weight in [
            (mean_arm,d.get("meanArmLength") or d["armLength"],470,1.2),
            (draft["fuselage"]["length"],d["fuselageLength"],475,.65),
            (draft["fuselage"]["horizontalDiameter"],d["fuselageHorizontalDiameter"],700,.55),
            (draft["fuselage"]["verticalDiameter"],d["fuselageVerticalDiameter"],303,.55),
            (wing_span,d["totalWingSpan"],2000,.8),(wing_chord,d["meanWingChord"],450,.65),
        ]) + (.18 if motor and motor!=d.get("primaryMotor") else 0)+(.18 if propeller and propeller!=d.get("primaryPropeller") else 0)+(.14 if battery and battery!=d.get("primaryBattery") else 0)
        neighbors.append((d,distance,1/(distance+.025)**2))
    neighbors=sorted(neighbors,key=lambda n:(n[1],n[0]["id"]))[:5] if designs else [(selected,0,1)]
    def metric(key):
        usable=[(d,w) for d,_,w in neighbors if positive(d.get(key))]
        return _js_sum(d[key]*w for d,w in usable)/max(_js_sum(w for _,w in usable),.0001) if usable else selected[key]
    base_arm=average([s["length"] for s in baseline["segments"]],selected["armLength"] or 300)
    arm_ratio=average([s["length"] for s in draft["segments"]],base_arm)/max(base_arm,1)
    body=lambda d: d["fuselage"]["length"]*d["fuselage"]["horizontalDiameter"]*d["fuselage"]["verticalDiameter"]
    body_ratio=clamp(body(draft)/max(body(baseline),1),.45,2.1)
    battery_ratio=clamp(_battery(batteries)/max(_battery(baseline["energy"]["batteryTypes"]),1),.55,1.9)
    area=lambda d: _js_sum(w["span"]*(w["chordInner"]+w["chordOuter"])*.5 for w in d["wings"])
    wing_ratio=clamp(area(draft)/max(area(baseline),1),.55,1.8) if area(baseline)>0 else 1
    component_changes=_js_sum(int(g.get(k)!=(baseline["propulsionGroups"][i].get(k) if i<len(baseline["propulsionGroups"]) else None)) for i,g in enumerate(groups) for k in ("motorType","propellerType"))
    component_changes+=_js_sum(v!=(baseline["energy"]["batteryTypes"][i] if i<len(baseline["energy"]["batteryTypes"]) else None) for i,v in enumerate(batteries))
    component_changes+=_js_sum(w["nacaProfile"]!=(baseline["wings"][i]["nacaProfile"] if i<len(baseline["wings"]) else None) for i,w in enumerate(draft["wings"]))
    def deltas(collection,key):
        return [abs(s[key]-(baseline[collection][i].get(key,s[key]) if i<len(baseline[collection]) else s[key])) for i,s in enumerate(draft[collection])]
    angle=average(deltas("segments","angle"),0); offset=average(deltas("segments","offset"),0); rotation=average(deltas("wings","rotation"),0)
    controls=_js_sum(value for pair in zip(deltas("wings","aileronBias"),deltas("wings","flapBias")) for value in pair)
    mass=max(.5,metric("mass")+(draft["payload"]["mass"]-baseline["payload"]["mass"])); mass_ratio=mass/max(selected["mass"],.5)
    layout=1+angle/900+offset/1800+rotation/720
    drag_factor=clamp(arm_ratio**1.12*body_ratio**.22/wing_ratio**.08*layout,.55,1.85); efficiency=max(.87,1-component_changes*.012)
    penalty=abs(math.log(arm_ratio))*18+abs(math.log(body_ratio))*15+abs(math.log(battery_ratio))*10+component_changes*2.8+angle*.06+offset*.025+rotation*.04+controls*5
    assumptions=["Deterministic nearest-design estimate with heuristic corrections, not a trained model or physics solver.","Neighbor weights are inverse squared distances; each KPI renormalizes over positive available observations.","Similarity is a distance display, not confidence or flight safety."]
    if not designs: assumptions.append("Dataset neighbors unavailable; baseline KPIs are used.")
    if not all(re.search(r"\d{3,6}mAh",v[0] if v else "",re.I) for v in (baseline["energy"]["batteryTypes"],batteries)): assumptions.append("Unrecognized battery capacity uses the existing 5000 mAh heuristic default.")
    return dict(mass=mass,range=metric("maxDistance")*battery_ratio**.22*efficiency/mass_ratio**.16,hover=metric("hoverTime")*battery_ratio**.24*efficiency/mass_ratio**.28,maxSpeed=metric("maxSpeed")*efficiency/drag_factor**.08,power=metric("power")*mass_ratio**.25*drag_factor**.18/efficiency,drag=metric("dragAt20")*drag_factor**.35,similarity=math.floor(max(35,100/(1+((neighbors[0][1] if neighbors else 0)+penalty/100)*2.8))+.5),closestId=neighbors[0][0]["id"] if neighbors else selected["id"],source="neighbor-estimate",modelVersion="neighbor-estimate-v1",neighbors=[dict(designId=d["id"],distance=distance,weight=weight) for d,distance,weight in neighbors],topologyFallbackUsed=bool(designs) and len(same)<8,appliedCorrections=dict(armRatio=arm_ratio,bodyRatio=body_ratio,batteryRatio=battery_ratio,wingRatio=wing_ratio,massRatio=mass_ratio,layoutDragPenalty=layout,dragFactor=drag_factor,efficiency=efficiency,componentChanges=component_changes),assumptions=assumptions,unsupportedInputs=(["topology-change"] if draft["topology"]!=baseline["topology"] else [])+["manufacturer-component-performance","physical-compatibility","flight-certification"])
