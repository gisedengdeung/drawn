"""Compare Python directly with the preserved browser contracts on real designs."""
import copy
import json
import shutil
import subprocess
from pathlib import Path
import pytest
from backend.app.domain.draft import hydrate_draft, fingerprint, is_design_draft

ROOT=Path(__file__).resolve().parents[2]


def test_hydration_fingerprints_and_structural_guards_match_typescript():
    node=shutil.which('node')
    if not node and Path(r'C:\Program Files\nodejs\node.exe').exists():
        node=r'C:\Program Files\nodejs\node.exe'
    if not node or not (ROOT/'node_modules/typescript').exists():
        pytest.skip('Node and frontend dependencies required for cross-language parity')
    examples=[]
    for design_id in [1,2,3,217,1001,5000,10000,15000,20000,25000]:
        data=json.loads((ROOT/f'public/data/design-trees/shard-{design_id//1000:03d}.json').read_text(encoding='utf-8'))
        examples.append({'id':design_id,'raw':data[str(design_id)]})
    malformed=[]
    for change in [{'baselineId':True},{'baselineId':28081},{'numWings':101},{'name':'x'*2001},{'nodes':{}},{'energy':{'configuration':'x','batteryTypes':[None]}},{'layout':{'wrong':{'x':0}}}]:
        malformed.append({**copy.deepcopy(examples[0]['raw']),**change})
    structured=copy.deepcopy(examples[0]['raw']);structured['parameterDefinitions']=[{'id':'a','path':'b','label':'c','group':'d','baseline':None,'range':None}]
    malformed.append(structured) # Missing value differs from explicit null.
    js="""import {loadTypeScript} from './tests/helpers/load-typescript.mjs';
const{hydrateDraft}=await loadTypeScript('lib/design-draft.ts');
const{draftFingerprint}=await loadTypeScript('lib/parts/bom.ts');
const{isDesignDraft}=await loadTypeScript('lib/design-gallery.ts');
let input='';for await(const chunk of process.stdin)input+=chunk;
const{examples,malformed}=JSON.parse(input);
process.stdout.write(JSON.stringify({examples:examples.map(({id,raw})=>{const hydrated=hydrateDraft(raw);return{id,hydrated,rawFingerprint:draftFingerprint(raw),hydratedFingerprint:draftFingerprint(hydrated),valid:isDesignDraft(hydrated)}}),malformed:malformed.map(isDesignDraft)}));"""
    process=subprocess.run([node,'--input-type=module','-e',js],input=json.dumps({'examples':examples,'malformed':malformed}),text=True,encoding='utf-8',capture_output=True,check=True,cwd=ROOT)
    expected=json.loads(process.stdout)
    for example,result in zip(examples,expected['examples']):
        hydrated=hydrate_draft(example['raw'])
        assert hydrated==result['hydrated'],example['id']
        assert fingerprint(example['raw'])==result['rawFingerprint'],example['id']
        assert fingerprint(hydrated)==result['hydratedFingerprint'],example['id']
        assert is_design_draft(hydrated)==result['valid'],example['id']
    assert [is_design_draft(value) for value in malformed]==expected['malformed']
