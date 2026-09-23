import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { hydrateDraft, cloneDraft } = await loadTypeScript('lib/design-draft.ts');
const { estimateDraft } = await loadTypeScript('lib/design-performance.ts');
const { recommendDatasetCandidates, listEditableParameters, applyDraftChanges, optimizeDraft, MAX_DRAFT_EVALUATIONS } = await loadTypeScript('lib/agent/optimization.ts');
const { searchKnowledge, getParameterInfo } = await loadTypeScript('lib/agent/knowledge.ts');
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
const designs = JSON.parse(readFileSync(new URL('../public/data/design-index.json', import.meta.url), 'utf8')).designs;
const selected = designs.find((design) => design.id === 1);
const baseline = hydrateDraft(shard['1']);
const metricKeys = ['mass', 'range', 'hover', 'maxSpeed', 'power', 'drag', 'similarity', 'closestId'];
const metrics = (result) => Object.fromEntries(metricKeys.map((key) => [key, result[key]]));
function simpleInput(objective = 'power') {
  const current = { ...selected, mass: 10, power: 1000, maxDistance: 1000, hoverTime: 100, maxSpeed: 20, dragAt20: 10, feasible: true };
  return { selected: current, baseline: cloneDraft(baseline), draft: cloneDraft(baseline), designs: [current], objective };
}
function changeFor(parameter, after) {
  return { id: parameter.id, before: parameter.value, after, label: parameter.label, unit: 'mm' };
}

test('unchanged estimate returns exact original KPIs and explicit dataset provenance', () => {
  const before = structuredClone(baseline);
  const result = estimateDraft(selected, baseline, baseline, designs);
  assert.deepEqual(metrics(result), { mass: selected.mass, range: selected.maxDistance, hover: selected.hoverTime, maxSpeed: selected.maxSpeed, power: selected.power, drag: selected.dragAt20, similarity: 100, closestId: 1 });
  assert.equal(result.source, 'dataset');
  assert.deepEqual(result.neighbors, [{ designId: 1, distance: 0, weight: 1 }]);
  assert.deepEqual(baseline, before);
});

test('extracted estimator preserves pre-extraction edited design #1 numerical results', () => {
  const draft = cloneDraft(baseline);
  draft.fuselage.length += 17;
  draft.segments[0].length *= 1.05;
  const result = estimateDraft(selected, draft, baseline, designs);
  const golden = { mass: 7.4311971966158925, range: 396.08529095444686, hover: 40.151250865527025, maxSpeed: 13.077362652929544, power: 2876.193792801377, drag: 0, similarity: 87, closestId: 1 };
  for (const key of metricKeys) assert.ok(Math.abs(result[key] - golden[key]) < 1e-10, key);
  assert.equal(result.source, 'neighbor-estimate');
  assert.equal(result.modelVersion, 'neighbor-estimate-v1');
  assert.deepEqual(result.neighbors.map((item) => item.designId), [1, 11053, 11759, 2670, 25086]);
  assert.ok(result.neighbors.every((item) => item.weight > 0 && item.distance >= 0));
  assert.ok(result.appliedCorrections.dragFactor > 0);
});

test('baseline recommendations enforce topology, finite constraints and stable ties', () => {
  const current = simpleInput().selected;
  const pool = [
    { ...current, id: 4, maxDistance: 1100 },
    { ...current, id: 3, maxDistance: 1100 },
    { ...current, id: 2, maxDistance: 5000, hub: 'other' },
    { ...current, id: 5, power: 5000 },
    { ...current, id: 6, mass: NaN },
    { ...current, id: 7, maxDistance: Infinity },
  ];
  const options = { objective: 'range', massLimit: 11, powerLimit: 1100, topologyLocked: true };
  const result = recommendDatasetCandidates(pool, current, options);
  assert.deepEqual(result.candidates.map((item) => item.id), [3, 4]);
  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result, recommendDatasetCandidates(pool, current, options));
  assert.equal(recommendDatasetCandidates(pool, current, { ...options, topologyLocked: false }).candidates[0].id, 2);
  assert.throws(() => recommendDatasetCandidates(pool, current, { ...options, massLimit: -1 }));
});

test('bounded optimization improves only the requested metric and retains protected fields', () => {
  const input = simpleInput();
  const original = structuredClone(input.draft);
  const result = optimizeDraft(input);
  assert.ok(result.proposals.length > 0 && result.proposals.length <= 3);
  assert.ok(result.evaluatedCount > 0 && result.evaluatedCount <= MAX_DRAFT_EVALUATIONS);
  assert.deepEqual(result, optimizeDraft(input));
  for (const proposal of result.proposals) {
    assert.ok(proposal.after.power < proposal.before.power);
    assert.ok(proposal.improvement > 0);
    const next = applyDraftChanges(input.draft, proposal.changes, input.baseline);
    for (const field of ['baselineId', 'topology', 'numPropellers', 'numWings', 'payload', 'energy', 'propulsionGroups', 'physicalComponents']) assert.deepEqual(next[field], original[field], field);
    assert.deepEqual(estimateDraft(input.selected, next, input.baseline, input.designs), proposal.after);
  }
  assert.deepEqual(input.draft, original);
});

test('locks prevent changes, and unchanged metrics produce no fabricated improvement', () => {
  const input = simpleInput();
  const locked = optimizeDraft({ ...input, lockedParameterIds: ['structure', 'fuselage', 'wing'] });
  assert.equal(locked.evaluatedCount, 0);
  assert.deepEqual(locked.proposals, []);
  assert.deepEqual(optimizeDraft({ ...input, lockedParameterIds: ['unmapped-user-lock'] }).proposals, []);
  assert.deepEqual(optimizeDraft(simpleInput('range')).proposals, []);
  assert.deepEqual(optimizeDraft({ ...input, powerLimit: 0.001 }).proposals, []);
});

test('application rejects stale values, forbidden targets, locks, duplicates and oversized changes', () => {
  const input = simpleInput();
  input.draft.fuselage.length = input.baseline.fuselage.length = 200;
  const parameter = listEditableParameters(input.draft, input.baseline).find((item) => item.id === 'fuselage:length');
  const change = changeFor(parameter, parameter.value * 0.95);
  assert.notEqual(applyDraftChanges(input.draft, [change], input.baseline).fuselage.length, input.draft.fuselage.length);
  assert.throws(() => applyDraftChanges(input.draft, [{ ...change, before: change.before + 1 }], input.baseline));
  assert.throws(() => applyDraftChanges(input.draft, [{ ...change, id: 'payload:mass' }], input.baseline));
  assert.throws(() => applyDraftChanges(input.draft, [change], input.baseline, ['fuselage']));
  assert.throws(() => applyDraftChanges(input.draft, [change, change], input.baseline));
  assert.throws(() => applyDraftChanges(input.draft, [{ ...change, after: change.before * 0.89 }], input.baseline));
  assert.throws(() => applyDraftChanges(input.draft, [{ ...change, after: NaN }], input.baseline));
  assert.throws(() => applyDraftChanges(input.draft, [{ ...change, after: change.before }], input.baseline));
});

test('exact declared bounds and read-only bindings are honored without raw parameter heuristics', () => {
  const input = simpleInput();
  input.draft.fuselage.length = input.baseline.fuselage.length = 200;
  const original = input.draft.fuselage.length;
  input.draft.parameterDefinitions.push({ id: 'exact-control', path: 'fuselage.length', label: 'Exact geometry binding', group: 'fuselage', unit: 'mm', range: { min: original - 1, max: original + 1 }, step: 1, baseline: original, value: original, editable: true, advanced: false, affectsGeometry: true, affectsPerformance: true });
  const parameter = listEditableParameters(input.draft, input.baseline).find((item) => item.id === 'fuselage:length');
  assert.equal(parameter.min, original - 1);
  assert.equal(parameter.max, original + 1);
  assert.throws(() => applyDraftChanges(input.draft, [changeFor(parameter, original - 2)], input.baseline));
  const next = applyDraftChanges(input.draft, [changeFor(parameter, original - 1)], input.baseline);
  assert.equal(next.parameterDefinitions.find((item) => item.id === 'exact-control').value, original - 1);
  assert.deepEqual(next.sourceParameters, input.draft.sourceParameters);
  input.draft.parameterDefinitions.at(-1).editable = false;
  assert.equal(listEditableParameters(input.draft, input.baseline).some((item) => item.id === 'fuselage:length'), false);
});

test('wing chord constraints reject invalid shapes and unknown topology is not optimized', () => {
  const input = simpleInput();
  input.draft.wings = [{ id: 'wing-a', path: 'wing', type: 'Wing', nacaProfile: '0012', span: 800, chordInner: 200, chordOuter: 200, taperOffset: true, rotation: 0, aileronBias: 0.5, flapBias: 0.5, load: 0, tubeOffset: 0 }];
  input.baseline.wings = structuredClone(input.draft.wings);
  const parameter = listEditableParameters(input.draft, input.baseline).find((item) => item.id === 'wing:wing-a:chordInner');
  assert.throws(() => applyDraftChanges(input.draft, [changeFor(parameter, 190)], input.baseline));
  input.draft.topology = 'different';
  assert.deepEqual(optimizeDraft(input).proposals, []);
});

test('knowledge retrieval returns only fixed versioned excerpts and real parameter metadata', () => {
  const sections = searchKnowledge('trim');
  assert.ok(sections.some((section) => section.id === 'trim-availability'));
  assert.ok(sections.every((section) => section.version === 'agent-knowledge-v1' && section.path.startsWith('docs/')));
  const first = structuredClone(sections);
  sections[0].keywords.push('mutation');
  assert.deepEqual(searchKnowledge('trim'), first);
  assert.deepEqual(searchKnowledge(''), []);
  assert.deepEqual(searchKnowledge('unknown_xyz123456'), []);
  const definition = baseline.parameterDefinitions[0];
  const info = getParameterInfo(baseline, definition.id);
  assert.equal(info[0].id, definition.id);
  assert.equal(info[0].unit, definition.unit);
  assert.equal(info[0].editable, definition.editable);
  assert.equal(info[0].value, definition.value);
  assert.deepEqual(info[0].range, definition.range);
});
test('Korean parameter questions resolve the actual English source labels', () => {
  const info = getParameterInfo(baseline, '\uc554 \uae38\uc774');
  assert.ok(info.length > 0);
  assert.match(info[0].label, /arm.*length/i);
  assert.ok(baseline.parameterDefinitions.some((parameter) => parameter.id === info[0].id));
});

test('real reverse-taper designs #2/#3 retain their original wings during unrelated geometry edits', () => {
  for (const id of [2, 3]) {
    const current = hydrateDraft(shard[String(id)]);
    assert.ok(current.wings.some((wing) => wing.chordOuter > wing.chordInner), `fixture ${id}`);
    const parameter = listEditableParameters(current, current).find((item) => item.id === 'fuselage:length');
    const next = applyDraftChanges(current, [changeFor(parameter, Math.round(parameter.value * 1.05))], current);
    assert.deepEqual(next.wings, current.wings);
    assert.notEqual(next.fuselage.length, current.fuselage.length);
    const summary = { ...designs.find((design) => design.id === id), mass: 10, power: 1000, maxDistance: 1000, hoverTime: 100, maxSpeed: 20, dragAt20: 10 };
    const optimized = optimizeDraft({ selected: summary, baseline: current, draft: current, designs: [summary], objective: 'power' });
    assert.ok(optimized.evaluatedCount > 0, `design ${id} remains searchable`);
    assert.ok(optimized.proposals.length > 0, `design ${id} can propose improvements`);
  }
});

test('existing reverse taper may narrow but cannot worsen or be newly introduced', () => {
  const current = hydrateDraft(shard['2']);
  const wing = current.wings.find((entry) => entry.chordOuter > entry.chordInner);
  const parameter = listEditableParameters(current, current).find((entry) => entry.id === `wing:${encodeURIComponent(wing.id)}:chordInner`);
  const next = applyDraftChanges(current, [changeFor(parameter, parameter.value * 1.05)], current);
  const revisedWing = next.wings.find((entry) => entry.id === wing.id);
  assert.ok(revisedWing.chordOuter / revisedWing.chordInner < wing.chordOuter / wing.chordInner);
  assert.throws(() => applyDraftChanges(current, [changeFor(parameter, parameter.value * 0.95)], current));
});