import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './helpers/load-typescript.mjs';
const { validateDraftAgainstBaseline } = await loadTypeScript('lib/agent/draft-validation.ts');
const { hydrateDraft } = await loadTypeScript('lib/design-draft.ts');
const { draftFingerprint, createBomSnapshot } = await loadTypeScript('lib/parts/bom.ts');
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
const catalogs = JSON.parse(readFileSync(new URL('../public/data/component-catalogs.json', import.meta.url), 'utf8'));
const baseline = (id = '1') => hydrateDraft(shard[id]);
const check = (draft, source = baseline()) => validateDraftAgainstBaseline(draft, source, catalogs);
const reject = (mutate, code) => {
  const draft = baseline(); mutate(draft);
  assert.throws(() => check(draft), error => !code || error.code === code);
};

test('real raw gallery drafts and hydrated server baselines round-trip without BOM or fingerprint changes', () => {
  for (const id of ['1', '2', '3']) {
    const source = baseline(id);
    const restored = check(shard[id], source);
    assert.equal(draftFingerprint(restored), draftFingerprint(source));
    assert.deepEqual(createBomSnapshot(restored).items, createBomSnapshot(source).items);
    assert.equal(draftFingerprint(check(source, source)), draftFingerprint(source));
  }
});

test('valid geometry, component choices and parameter edits preserve immutable dataset identity', () => {
  const source = baseline(), draft = structuredClone(source);
  draft.fuselage.length = 120;
  draft.segments[0].length = 100;
  draft.propulsionGroups[0].motorType = catalogs.motors.find(model => model !== source.propulsionGroups[0].motorType);
  draft.energy.batteryTypes[0] = catalogs.batteries.find(model => model !== source.energy.batteryTypes[0]);
  draft.wings[0].nacaProfile = catalogs.nacaProfiles.find(profile => profile !== source.wings[0].nacaProfile);
  const parameter = draft.parameterDefinitions.find(def => def.label === 'CargoMass');
  parameter.value = 1;
  const saved = check(draft, source);
  assert.equal(saved.fuselage.length, 120);
  assert.equal(saved.propulsionGroups[0].motorType, draft.propulsionGroups[0].motorType);
  assert.deepEqual(saved.physicalComponents, source.physicalComponents);
  assert.deepEqual(saved.nodes, source.nodes);
  assert.equal(saved.parameterDefinitions.find(def => def.label === 'CargoMass').value, 1);
  assert.equal(source.fuselage.length, 84);
});

test('physical instance remapping and structural tampering cannot change authoritative BOM identity', () => {
  for (const mutate of [
    d => { d.propulsionGroups[0].motorInstance = d.propulsionGroups[1].motorInstance; },
    d => { d.propulsionGroups[0].propellerInstance = 'invented'; },
    d => { d.segments[0].multiplicity += 1; },
    d => { d.segments[0].nodeType = 'invented'; },
    d => { d.segments[0].depth += 1; },
    d => { d.physicalComponents.motors[0].choice = 'invented'; },
    d => { d.energy.batteryTypes.push(d.energy.batteryTypes[0]); },
    d => { d.energy.configuration = 'invented'; },
    d => { d.wings[0].path = 'physical.Wing_foreign'; },
    d => { d.layout.invented = { x: 0, y: 0 }; },
  ]) reject(mutate, 'invalid_structure');
});

test('all editable component and profile choices must exist in the server catalog', () => {
  for (const mutate of [
    d => { d.propulsionGroups[0].motorType = 'Not a real motor'; },
    d => { d.propulsionGroups[0].propellerType = 'Not a real propeller'; },
    d => { d.energy.batteryTypes[0] = 'Not a real battery'; },
    d => { d.wings[0].servoType = 'Not a real servo'; },
    d => { d.wings[0].nacaProfile = 'Not a real profile'; },
    d => { d.segments[0].motorType = 'Not a real motor'; },
  ]) reject(mutate, 'unknown_component');
});

test('direct geometry fields cannot bypass limits through otherwise valid source parameters', () => {
  for (const mutate of [
    d => { d.fuselage.length = 1e8; },
    d => { d.fuselage.horizontalDiameter = -1; },
    d => { d.payload.mass = -1; },
    d => { d.segments[0].length = 1e8; },
    d => { d.segments[0].offset = 1e8; },
    d => { d.wings[0].span = 1e8; },
    d => { d.wings[0].aileronBias = 1e8; },
    d => { d.layout[Object.keys(d.layout)[0]].x = 1e8; },
  ]) reject(mutate, 'out_of_range');
});

test('read-only flags, parameter types and ranges come from server definitions', () => {
  reject(d => { const p = d.parameterDefinitions.find(def => !def.editable && typeof def.value === 'number'); assert.ok(p); p.editable = true; p.value += 1; }, 'readonly_parameter');
  reject(d => { const p = d.parameterDefinitions.find(def => def.editable && typeof def.value === 'number'); p.value = '200'; }, 'invalid_parameter_type');
  reject(d => { const p = d.parameterDefinitions.find(def => def.editable && typeof def.value === 'number'); p.value = null; }, 'invalid_parameter_type');
  reject(d => { const p = d.parameterDefinitions.find(def => def.editable && typeof def.value === 'number'); p.range = { min: -1e9, max: 1e9 }; p.value = 1e8; }, 'out_of_range');
  reject(d => { d.parameterDefinitions[0].id = 'foreign'; }, 'invalid_parameter');
  reject(d => { d.parameterDefinitions[1].id = d.parameterDefinitions[0].id; }, 'invalid_parameter');
  reject(d => { d.parameterDefinitions.pop(); }, 'invalid_parameter');
});

test('known baseline outliers retain the actual editor envelope without trusting submitted extrema', () => {
  const source = baseline(); source.fuselage.length = 700.25;
  const draft = structuredClone(source); draft.fuselage.length = 701;
  assert.equal(check(draft, source).fuselage.length, 701);
  draft.fuselage.length = 702;
  assert.throws(() => check(draft, source), error => error.code === 'out_of_range');
  assert.equal(check(baseline('2'), baseline('2')).wings[0].chordOuter, baseline('2').wings[0].chordOuter);
});

test('explicit source field bounds extend a control but unrelated or forged metadata cannot', () => {
  const draft = baseline();
  draft.parameterDefinitions.find(def => def.label === 'FUSELAGE_LENGTH').value = 60;
  draft.fuselage.length = 60;
  assert.equal(check(draft).fuselage.length, 60);
  draft.fuselage.length = 600;
  draft.parameterDefinitions.find(def => def.label === 'FUSELAGE_LENGTH').range.max = 1000;
  assert.throws(() => check(draft), error => error.code === 'out_of_range');
});

test('untrusted extra fields and definition metadata are absent from the persisted reconstruction', () => {
  const draft = baseline();
  draft.providerOverride = 'https://foreign.test';
  draft.parameterDefinitions[0].path = 'invented';
  draft.parameterDefinitions[0].range = { min: -1e8, max: 1e8 };
  const saved = check(draft);
  assert.equal(saved.providerOverride, undefined);
  assert.deepEqual(saved.parameterDefinitions, baseline().parameterDefinitions);
});
