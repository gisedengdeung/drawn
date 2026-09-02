import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const dataRoot = path.resolve(projectRoot, '..', 'AircraftVerse_1', 'AircraftVerse_1');
const publicDataDir = path.join(projectRoot, 'public', 'data');
const publicModelsDir = path.join(projectRoot, 'public', 'models');
const showcaseIds = new Set([1000, 12291, 12883, 16095, 16491, 17297]);

if (!fs.existsSync(dataRoot)) {
  throw new Error(`AircraftVerse data directory not found: ${dataRoot}`);
}

fs.mkdirSync(publicDataDir, { recursive: true });
fs.mkdirSync(publicModelsDir, { recursive: true });

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getSequenceValue(sequence, key) {
  return sequence.find((entry) => Object.hasOwn(entry, key))?.[key] ?? null;
}

function getSequenceValues(sequence, key) {
  return sequence.filter((entry) => Object.hasOwn(entry, key)).map((entry) => entry[key]);
}

function parseNpyFloat64(filePath) {
  const buffer = fs.readFileSync(filePath);
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const dataOffset = (major === 1 ? 10 : 12) + headerLength;
  const count = (buffer.length - dataOffset) / 8;
  const values = Array.from({ length: count });
  for (let index = 0; index < count; index += 1) {
    const value = buffer.readDoubleLE(dataOffset + index * 8);
    values[index] = Number.isFinite(value) ? value : null;
  }
  return values;
}

function createTrimRows(filePath) {
  const values = parseNpyFloat64(filePath);
  const fields = [
    'distance',
    'flightTime',
    'pitch',
    'maxUc',
    'thrust',
    'lift',
    'drag',
    'current',
    'power',
    'motorCurrentRatio',
    'motorPowerRatio',
    'batteryCurrentRatio',
  ];

  return Array.from({ length: 51 }, (_, speed) => {
    const row = Object.fromEntries(
      fields.map((field, column) => [field, values[speed * 12 + column]]),
    );
    const numericValues = Object.values(row).filter((value) => typeof value === 'number');
    return {
      speed,
      ...row,
      valid: numericValues.length === fields.length && numericValues.some((value) => value !== 0),
    };
  });
}

function readTrimAt(filePath, speed) {
  const buffer = fs.readFileSync(filePath);
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const dataOffset = (major === 1 ? 10 : 12) + headerLength + speed * 12 * 8;
  const row = Array.from({ length: 12 }, (_, column) => buffer.readDoubleLE(dataOffset + column * 8));
  const valid = row.every(Number.isFinite) && row.some((value) => value !== 0);
  return { valid, drag: valid ? row[6] : 0, power: valid ? row[8] : 0 };
}

const folders = fs
  .readdirSync(dataRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name))
  .sort((a, b) => Number(a.name.slice(7)) - Number(b.name.slice(7)));

const designs = [];
const showcase = {};
const propellerCounts = new Map();
const wingCounts = new Map();

for (const folder of folders) {
  const id = Number(folder.name.slice(7));
  const designDir = path.join(dataRoot, folder.name);
  const output = readJson(path.join(designDir, 'output.json'));
  const sequence = readJson(path.join(designDir, 'design_seq.json'));
  const lowLevel = readJson(path.join(designDir, 'design_low_level.json'));
  const components = lowLevel.components ?? [];
  const numPropellers = components.filter((component) => component.component_type === 'Propeller').length;
  const numWings = components.filter((component) => component.component_type === 'Wing').length;
  const hub = getSequenceValues(sequence, 'node_type').find((value) => String(value).startsWith('ConnectedHub')) ?? 'Unknown';
  const armLength = Number(getSequenceValue(sequence, 'armLength') ?? getSequenceValue(sequence, 'arm1Length') ?? 0);
  const trim20 = readTrimAt(path.join(designDir, 'trims.npy'), 20);
  const metadata = {
    id,
    mass: Number(output.Mass) || 0,
    maxDistance: Number(output.Max_Distance) || 0,
    hoverTime: Number(output.Hover_Time) || 0,
    maxSpeed: Number(output.Max_Speed) || 0,
    power: Number(output.Power_MFD) || 0,
    speedMfd: Number(output.Speed_MFD) || 0,
    interferences: Number(output.Interferences) || 0,
    numPropellers,
    numWings,
    hub,
    armLength,
    dragAt20: trim20.drag,
    powerAt20: trim20.power,
    feasible: Number(output.Max_Distance) > 0,
    viewerReady: showcaseIds.has(id),
  };

  designs.push(metadata);
  propellerCounts.set(numPropellers, (propellerCounts.get(numPropellers) ?? 0) + 1);
  wingCounts.set(numWings, (wingCounts.get(numWings) ?? 0) + 1);

  if (showcaseIds.has(id)) {
    const modelName = `design-${id}.stl`;
    fs.copyFileSync(path.join(designDir, 'cadfile.stl'), path.join(publicModelsDir, modelName));
    showcase[id] = {
      ...metadata,
      sourceName: getSequenceValue(sequence, 'name'),
      generatorVersion: getSequenceValue(sequence, 'generator_version'),
      motor: getSequenceValue(sequence, 'motorType'),
      propeller: getSequenceValue(sequence, 'propType'),
      battery: getSequenceValue(sequence, 'batteryType'),
      wingType: getSequenceValue(sequence, 'wingType'),
      nacaProfile: getSequenceValue(sequence, 'nacaProfile'),
      wingSpan: Number(getSequenceValue(sequence, 'span') ?? 0),
      wingChord: Number(getSequenceValue(sequence, 'chordInner') ?? 0),
      modelPath: `/models/${modelName}`,
      trim: createTrimRows(path.join(designDir, 'trims.npy')),
      output,
    };
  }
}

const validDesigns = designs.filter((design) => design.feasible);
const summary = {
  aircraftVerseTotal: 27714,
  localDesigns: designs.length,
  validRangeDesigns: validDesigns.length,
  validHoverDesigns: designs.filter((design) => design.hoverTime > 0).length,
  wingedDesigns: designs.filter((design) => design.numWings > 0).length,
  propellerDistribution: Object.fromEntries([...propellerCounts.entries()].sort((a, b) => a[0] - b[0])),
  wingDistribution: Object.fromEntries([...wingCounts.entries()].sort((a, b) => a[0] - b[0])),
  indexedAt: new Date().toISOString(),
  source: 'AircraftVerse local subset',
  trimSchema: [
    'distance',
    'flightTime',
    'pitch',
    'maxUc',
    'thrust',
    'lift',
    'drag',
    'current',
    'power',
    'motorCurrentRatio',
    'motorPowerRatio',
    'batteryCurrentRatio',
  ],
};

fs.writeFileSync(
  path.join(publicDataDir, 'design-index.json'),
  JSON.stringify({ summary, designs }),
);
fs.writeFileSync(
  path.join(publicDataDir, 'showcase-designs.json'),
  JSON.stringify(showcase),
);

console.log(
  `Indexed ${designs.length.toLocaleString()} designs and prepared ${Object.keys(showcase).length} showcase models.`,
);
