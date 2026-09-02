import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const dataDir = path.join(projectRoot, 'public', 'data');
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const index = readJson(path.join(dataDir, 'design-index.json'));
const showcases = readJson(path.join(dataDir, 'showcase-designs.json'));
const pareto = readJson(path.join(dataDir, 'pareto-front.json'));
const shardFiles = fs
  .readdirSync(path.join(dataDir, 'design-trees'))
  .filter((name) => name.endsWith('.json'))
  .sort();

assert(index.designs.length === 27714, `Expected 27,714 summaries, found ${index.designs.length}`);
assert(new Set(index.designs.map((design) => design.id)).size === 27714, 'Duplicate summary design ID');
assert(shardFiles.length === index.summary.shardCount, 'Shard count differs from summary');
const summaryById = new Map(index.designs.map((design) => [design.id, design]));

let draftCount = 0;
const draftIds = new Set();
for (const shardFile of shardFiles) {
  const shard = readJson(path.join(dataDir, 'design-trees', shardFile));
  for (const [idText, draft] of Object.entries(shard)) {
    const id = Number(idText);
    const summary = summaryById.get(id);
    assert(summary, `Draft #${id} has no summary`);
    assert(!draftIds.has(id), `Duplicate draft #${id}`);
    draftIds.add(id);
    draftCount += 1;
    assert(draft.sourceParameters.length === summary.parameterCount, `Parameter count mismatch for #${id}`);
    assert(draft.physicalComponents.motors.length === summary.numPropellers, `Motor count mismatch for #${id}`);
    assert(draft.physicalComponents.propellers.length === summary.numPropellers, `Propeller count mismatch for #${id}`);
    assert(draft.physicalComponents.wings.length === summary.numWings, `Wing count mismatch for #${id}`);
    const segmentPaths = new Set(draft.segments.map((segment) => segment.path));
    for (const segment of draft.segments) {
      assert(!segment.parentPath || segmentPaths.has(segment.parentPath), `Missing parent ${segment.parentPath} for #${id}`);
    }
  }
}
assert(draftCount === 27714, `Expected 27,714 drafts, found ${draftCount}`);

for (const [id, showcase] of Object.entries(showcases)) {
  assert(showcase.trim.length === 51, `Showcase #${id} must have 51 trim rows`);
  for (const row of showcase.trim) {
    for (const [field, valid] of Object.entries(row.fieldValidity)) {
      assert(valid === (row[field] !== null), `Trim validity mismatch for #${id} at ${row.speed}m/s ${field}`);
    }
  }
}

assert(pareto.designIds.includes(pareto.kneeId), 'Pareto knee is not on the front');
for (const id of pareto.designIds) {
  const design = summaryById.get(id);
  assert(design, `Pareto design #${id} is missing`);
  const dominated = index.designs.some(
    (candidate) =>
      candidate.feasible &&
      candidate.power > 0 &&
      candidate.mass > 0 &&
      candidate.maxDistance > 0 &&
      candidate.power <= design.power &&
      candidate.mass <= design.mass &&
      candidate.maxDistance >= design.maxDistance &&
      (candidate.power < design.power || candidate.mass < design.mass || candidate.maxDistance > design.maxDistance),
  );
  assert(!dominated, `Pareto design #${id} is dominated`);
}

console.log(
  `Validated ${draftCount.toLocaleString()} drafts, ${shardFiles.length} shards, ${pareto.designIds.length} Pareto designs, and ${Object.keys(showcases).length} showcases.`,
);
