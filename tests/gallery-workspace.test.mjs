import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { hydrateDraft } = await loadTypeScript('lib/design-draft.ts');
const { isDesignDraft } = await loadTypeScript('lib/design-gallery.ts');
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));

test('raw gallery designs become editable without changing the shared source', () => {
  const source = structuredClone(shard['1']);
  assert.ok(isDesignDraft(source));
  assert.equal(source.parameterDefinitions.length, 0);
  assert.equal(source.sourceParameters.length, 108);
  const imported = hydrateDraft(source);
  assert.ok(isDesignDraft(imported));
  assert.equal(imported.parameterDefinitions.length, 108);
  assert.ok(imported.parameterDefinitions.some((parameter) => parameter.editable));
  assert.deepEqual(imported.physicalComponents, source.physicalComponents);
  assert.deepEqual(imported.sourceParameters, source.sourceParameters);
  assert.equal(source.parameterDefinitions.length, 0);
  imported.sourceParameters[0][1] = 'independent imported copy';
  assert.notEqual(source.sourceParameters[0][1], imported.sourceParameters[0][1]);
});

test('restoring an edited snapshot retains parameter values, geometry and gallery lineage', () => {
  const draft = hydrateDraft(shard['1']);
  const parameter = draft.parameterDefinitions.find((item) => item.editable && typeof item.value === 'number');
  assert.ok(parameter);
  parameter.value += 7;
  draft.fuselage.length += 15;
  const stored = JSON.parse(JSON.stringify({ draft, sourceId: 'gallery-source-1' }));
  const restored = { ...stored, draft: hydrateDraft(stored.draft) };
  assert.deepEqual(restored, stored);
  assert.notEqual(restored.draft, stored.draft);
  assert.ok(isDesignDraft(restored.draft));
});
