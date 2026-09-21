"""Golden compatibility checks against the original TypeScript implementation."""
import copy
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import pytest

from backend.app.core.errors import ApiError
from backend.app.domain.optimization import MAX_DRAFT_EVALUATIONS, apply_draft_changes, list_editable_parameters, optimize_draft, recommend_dataset_candidates

ROOT = Path(__file__).resolve().parents[2]
NODE_REFERENCE = r"""
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './tests/helpers/load-typescript.mjs';
const { hydrateDraft } = await loadTypeScript('lib/design-draft.ts');
const { listEditableParameters, applyDraftChanges, optimizeDraft, recommendDatasetCandidates } = await loadTypeScript('lib/agent/optimization.ts');
const designs = JSON.parse(readFileSync('public/data/design-index.json', 'utf8')).designs;
const baselines = [1,2,3,17297,20015].map(id => {
  const shard=String(Math.floor(id/1000)).padStart(3,'0');
  const raw=JSON.parse(readFileSync('public/data/design-trees/shard-'+shard+'.json','utf8'));
  const draft=hydrateDraft(raw[String(id)]);
  return {id,draft,parameters:listEditableParameters(draft)};
});
const optimizations=[];
for(const fixture of baselines.slice(0,3)){
  const selected={...designs.find(d=>d.id===fixture.id),mass:10,power:1000,maxDistance:1000,hoverTime:100,maxSpeed:20,dragAt20:10,feasible:true};
  for(const objective of ['power','drag','balanced','range']){
    const input={selected,baseline:fixture.draft,draft:fixture.draft,designs:[selected],objective};
    optimizations.push({input,result:optimizeDraft(input)});
  }
}
const selected=designs.find(d=>d.id===1);
const recommendations=['range','hover','power','drag','speed','balanced'].flatMap(objective=>[true,false].map(topologyLocked=>{
  const options={objective,massLimit:30,powerLimit:10000,topologyLocked};
  return {options,result:recommendDatasetCandidates(designs,selected,options)};
}));
const applications=baselines.map(fixture=>{
  const p=fixture.parameters.find(p=>p.id==='fuselage:length');
  const changes=[{id:p.id,label:p.label,before:p.value,after:Math.round(p.value*1.05),unit:'mm'}];
  return {id:fixture.id,changes,result:applyDraftChanges(fixture.draft,changes)};
});
process.stdout.write(JSON.stringify({baselines,optimizations,recommendations,applications}));
"""

@pytest.fixture(scope="module")
def reference():
    node = shutil.which("node")
    if not node:
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "nodejs/node.exe"
        node = str(candidate) if candidate.exists() else None
    if not node:
        pytest.fail("Node.js is required for the TypeScript compatibility reference.")
    result = subprocess.run([node,"--input-type=module","-e",NODE_REFERENCE], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8", timeout=120)
    return json.loads(result.stdout)

def assert_compatible(actual, expected, path="$"):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), path
        for key in expected: assert_compatible(actual[key], expected[key], path+"."+key)
    elif isinstance(expected, list):
        assert len(actual) == len(expected), path
        for index,value in enumerate(expected): assert_compatible(actual[index],value,f"{path}[{index}]")
    elif isinstance(expected,(int,float)) and not isinstance(expected,bool):
        assert isinstance(actual,(int,float)) and not isinstance(actual,bool),path
        assert actual == pytest.approx(expected, rel=1e-12, abs=1e-11),path
    else:
        assert actual == expected,path

def change_for(parameter, after):
    return dict(id=parameter["id"], label=parameter["label"], before=parameter["value"], after=after, unit="mm")

@pytest.mark.parametrize("design_id",[1,2,3,17297,20015])
def test_actual_parameters_and_application_match_typescript(reference,design_id):
    fixture=next(item for item in reference["baselines"] if item["id"]==design_id)
    original=copy.deepcopy(fixture["draft"])
    assert_compatible(list_editable_parameters(original),fixture["parameters"])
    application=next(item for item in reference["applications"] if item["id"]==design_id)
    assert_compatible(apply_draft_changes(original,application["changes"]),application["result"])
    assert original==fixture["draft"]

def test_all_objectives_and_topology_constraints_match_typescript_ranking(reference):
    designs=json.loads((ROOT/"public/data/design-index.json").read_text(encoding="utf-8"))["designs"]
    selected=next(design for design in designs if design["id"]==1)
    for case in reference["recommendations"]:
        assert_compatible(recommend_dataset_candidates(designs,selected,case["options"]),case["result"],str(case["options"]))

def test_bounded_optimization_matches_typescript_with_reverse_taper_designs(reference):
    for case in reference["optimizations"]:
        source=case["input"]; original=copy.deepcopy(source["draft"])
        result=optimize_draft(**source)
        assert_compatible(result,case["result"],f"design={source['selected']['id']},objective={source['objective']}")
        assert 0<=result["evaluatedCount"]<=MAX_DRAFT_EVALUATIONS
        assert source["draft"]==original
        for proposal in result["proposals"]:
            revised=apply_draft_changes(source["draft"],proposal["changes"],source["baseline"])
            for field in ("baselineId","topology","numPropellers","numWings","payload","energy","propulsionGroups","physicalComponents"):
                assert revised[field]==source["draft"][field]

def test_stale_forbidden_locked_duplicate_and_oversized_changes_fail(reference):
    draft=copy.deepcopy(reference["baselines"][0]["draft"]); draft["fuselage"]["length"]=200
    parameter=next(item for item in list_editable_parameters(draft) if item["id"]=="fuselage:length")
    change=change_for(parameter,190)
    for changes in [[{**change,"before":201}],[{**change,"id":"payload:mass"}],[change,change],[{**change,"after":178}],[{**change,"after":math.nan}],[{**change,"after":math.inf}],[{**change,"after":True}],[{**change,"after":200}],[],[change]*13]:
        with pytest.raises(ApiError): apply_draft_changes(draft,changes)
    for locks in [["fuselage"],["fuselage:length"],["fuselage.length"],["all"],["*"],["unmapped-lock"]]:
        with pytest.raises(ApiError): apply_draft_changes(draft,[change],locks=locks)

def test_exact_bounds_readonly_and_raw_group_locks_remain_conservative(reference):
    draft=copy.deepcopy(reference["baselines"][0]["draft"]); draft["fuselage"]["length"]=200
    binding=dict(id="exact-control",path="fuselage.length",label="Exact binding",group="fuselage",unit="mm",range={"min":199,"max":201},min=199,max=201,step=1,baseline=200,value=200,editable=True,advanced=False,affectsGeometry=True,affectsPerformance=True)
    draft["parameterDefinitions"].append(binding)
    parameter=next(item for item in list_editable_parameters(draft) if item["id"]=="fuselage:length")
    assert (parameter["min"],parameter["max"])==(199,201)
    with pytest.raises(ApiError): apply_draft_changes(draft,[change_for(parameter,198)])
    revised=apply_draft_changes(draft,[change_for(parameter,199)])
    assert revised["parameterDefinitions"][-1]["value"]==199
    assert revised["sourceParameters"]==draft["sourceParameters"]
    with pytest.raises(ApiError): apply_draft_changes(draft,[change_for(parameter,199)],locks=["exact-control"])
    binding["editable"]=False
    assert all(item["id"]!="fuselage:length" for item in list_editable_parameters(draft))

def test_reverse_taper_can_narrow_but_never_increase(reference):
    draft=copy.deepcopy(next(item for item in reference["baselines"] if item["id"]==2)["draft"])
    wing=next(item for item in draft["wings"] if item["chordOuter"]>item["chordInner"])
    parameter=next(item for item in list_editable_parameters(draft) if item["path"]==f"wings.{draft['wings'].index(wing)}.chordInner")
    changed=apply_draft_changes(draft,[change_for(parameter,parameter["value"]*1.05)])
    revised=next(item for item in changed["wings"] if item["id"]==wing["id"])
    assert revised["chordOuter"]/revised["chordInner"]<wing["chordOuter"]/wing["chordInner"]
    with pytest.raises(ApiError): apply_draft_changes(draft,[change_for(parameter,parameter["value"]*.95)])

def test_locks_and_invalid_performance_never_fabricate_a_proposal(reference):
    source=copy.deepcopy(reference["optimizations"][0]["input"])
    for locks in [["structure","fuselage","wing"],["unknown-raw-lock"]]:
        result=optimize_draft(**source,lockedParameterIds=locks)
        assert result["evaluatedCount"]==0 and result["proposals"]==[]
    assert optimize_draft(**source,powerLimit=.001)["proposals"]==[]
    source["draft"]["topology"]="different"
    assert optimize_draft(**source)["proposals"]==[]
    source["draft"]["baselineId"]=-1
    with pytest.raises(ApiError): optimize_draft(**source)
