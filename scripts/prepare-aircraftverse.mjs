import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const publicDataDir = path.join(projectRoot, 'public', 'data');
const publicModelsDir = path.join(projectRoot, 'public', 'models');
const defaultShowcaseId = 17297;
const expectedPartCount = 3;
const expectedDesignsPerPart = 9238;
const expectedTotalDesigns = 27714;
const requiredFiles = [
  'cadfile.stl',
  'Geom.stp',
  'design_low_level.json',
  'design_seq.json',
  'design_tree.json',
  'output.json',
  'pointCloud.npy',
  'trims.npy',
];
const trimFields = [
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

function parseArgs(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--data-root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--data-root requires a directory path.');
      roots.push(value);
      index += 1;
    } else if (argument.startsWith('--data-root=')) {
      roots.push(argument.slice('--data-root='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return roots;
}

function hasDesignFolders(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
  return fs.readdirSync(candidate, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name),
  );
}

function resolveDesignRoot(candidate) {
  const absolute = path.resolve(candidate);
  if (hasDesignFolders(absolute)) return absolute;
  const nested = path.join(absolute, path.basename(absolute));
  if (hasDesignFolders(nested)) return nested;
  const child = fs.existsSync(absolute)
    ? fs.readdirSync(absolute, { withFileTypes: true }).find(
        (entry) => entry.isDirectory() && !entry.name.startsWith('__') && hasDesignFolders(path.join(absolute, entry.name)),
      )
    : null;
  if (child) return path.join(absolute, child.name);
  throw new Error(`AircraftVerse design directory not found: ${absolute}`);
}

function discoverDataRoots() {
  const explicitRoots = parseArgs(process.argv.slice(2));
  const candidates = explicitRoots.length
    ? explicitRoots
    : fs.readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^AircraftVerse_\d+$/.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((entry) => path.join(workspaceRoot, entry.name));
  if (!candidates.length) {
    throw new Error(`No AircraftVerse_* directories found under ${workspaceRoot}`);
  }
  return candidates.map(resolveDesignRoot);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeBinaryStl(sourcePath, destinationPath) {
  const source = fs.readFileSync(sourcePath);
  const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const geometry = new STLLoader().parse(arrayBuffer);
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  if (!positions || positions.count % 3 !== 0) {
    geometry.dispose();
    throw new Error(`Invalid STL triangle geometry: ${sourcePath}`);
  }

  const triangleCount = positions.count / 3;
  const binary = Buffer.alloc(84 + triangleCount * 50);
  binary.write('AeroTwin AircraftVerse binary STL', 0, 'ascii');
  binary.writeUInt32LE(triangleCount, 80);
  let offset = 84;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const firstVertex = triangle * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      binary.writeFloatLE(normals?.getComponent(firstVertex, axis) ?? 0, offset);
      offset += 4;
    }
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        binary.writeFloatLE(positions.getComponent(firstVertex + vertex, axis), offset);
        offset += 4;
      }
    }
    binary.writeUInt16LE(0, offset);
    offset += 2;
  }

  geometry.dispose();
  fs.writeFileSync(destinationPath, binary);
}

function getSequenceValue(sequence, key) {
  return sequence.find((entry) => Object.hasOwn(entry, key))?.[key] ?? null;
}

function getSequenceValues(sequence, key) {
  return sequence.filter((entry) => Object.hasOwn(entry, key)).map((entry) => entry[key]);
}

function readNpyHeader(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 16 || buffer.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new Error(`Invalid NPY file: ${filePath}`);
  }
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerOffset = major === 1 ? 10 : 12;
  const header = buffer.toString('latin1', headerOffset, headerOffset + headerLength);
  const descr = header.match(/'descr':\s*'([^']+)'/)?.[1];
  const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1] ?? '';
  const shape = shapeText.split(',').map((value) => Number(value.trim())).filter(Number.isFinite);
  return { buffer, dataOffset: headerOffset + headerLength, descr, shape };
}

function assertNpySchema(filePath, expectedDescr, expectedShape) {
  const metadata = readNpyHeader(filePath);
  if (
    metadata.descr !== expectedDescr ||
    metadata.shape.length !== expectedShape.length ||
    metadata.shape.some((value, index) => value !== expectedShape[index])
  ) {
    throw new Error(
      `Unexpected NPY schema at ${filePath}: ${metadata.descr} (${metadata.shape.join(', ')})`,
    );
  }
  return metadata;
}

function createTrimRows(filePath) {
  const metadata = assertNpySchema(filePath, '<f8', [51, 12]);
  return Array.from({ length: 51 }, (_, speed) => {
    const row = Object.fromEntries(
      trimFields.map((field, column) => {
        const value = metadata.buffer.readDoubleLE(metadata.dataOffset + (speed * 12 + column) * 8);
        return [field, Number.isFinite(value) ? value : null];
      }),
    );
    const numericValues = Object.values(row).filter((value) => typeof value === 'number');
    return {
      speed,
      ...row,
      valid: numericValues.some((value) => value !== 0),
    };
  });
}

function readTrimAt(metadata, speed) {
  const row = Array.from({ length: 12 }, (_, column) =>
    metadata.buffer.readDoubleLE(metadata.dataOffset + (speed * 12 + column) * 8),
  );
  const isUsable = (value) => Number.isFinite(value) && value !== 0;
  return {
    valid: row.some(isUsable),
    drag: isUsable(row[6]) ? row[6] : 0,
    power: isUsable(row[8]) ? row[8] : 0,
  };
}

function compareDescending(metric) {
  return (a, b) => metric(b) - metric(a) || a.id - b.id;
}

function compareAscending(metric) {
  return (a, b) => metric(a) - metric(b) || a.id - b.id;
}

function findParetoFront(designs) {
  const sorted = [...designs].sort(
    (a, b) => b.maxDistance - a.maxDistance || a.power - b.power || a.mass - b.mass || a.id - b.id,
  );
  const powers = [...new Set(sorted.map((design) => design.power))].sort((a, b) => a - b);
  const powerIndex = new Map(powers.map((power, index) => [power, index + 1]));
  const minimumMassTree = Array.from(
    { length: powers.length + 1 },
    () => Number.POSITIVE_INFINITY,
  );
  const queryMinimumMass = (index) => {
    let minimum = Number.POSITIVE_INFINITY;
    for (let cursor = index; cursor > 0; cursor -= cursor & -cursor) {
      minimum = Math.min(minimum, minimumMassTree[cursor]);
    }
    return minimum;
  };
  const recordMass = (index, mass) => {
    for (let cursor = index; cursor < minimumMassTree.length; cursor += cursor & -cursor) {
      minimumMassTree[cursor] = Math.min(minimumMassTree[cursor], mass);
    }
  };

  const front = [];
  for (const design of sorted) {
    const index = powerIndex.get(design.power);
    if (queryMinimumMass(index) <= design.mass) continue;
    front.push(design);
    recordMass(index, design.mass);
  }
  return front;
}

function createIdealDistance(designs) {
  const bounds = designs.reduce(
    (accumulator, design) => ({
      rangeMin: Math.min(accumulator.rangeMin, design.maxDistance),
      rangeMax: Math.max(accumulator.rangeMax, design.maxDistance),
      powerMin: Math.min(accumulator.powerMin, design.power),
      powerMax: Math.max(accumulator.powerMax, design.power),
      massMin: Math.min(accumulator.massMin, design.mass),
      massMax: Math.max(accumulator.massMax, design.mass),
    }),
    {
      rangeMin: Number.POSITIVE_INFINITY,
      rangeMax: Number.NEGATIVE_INFINITY,
      powerMin: Number.POSITIVE_INFINITY,
      powerMax: Number.NEGATIVE_INFINITY,
      massMin: Number.POSITIVE_INFINITY,
      massMax: Number.NEGATIVE_INFINITY,
    },
  );
  const normalize = (value, minimum, maximum) => (value - minimum) / Math.max(maximum - minimum, 1);
  return (design) => Math.hypot(
    1 - normalize(design.maxDistance, bounds.rangeMin, bounds.rangeMax),
    normalize(design.power, bounds.powerMin, bounds.powerMax),
    normalize(design.mass, bounds.massMin, bounds.massMax),
  );
}

function selectShowcases(designs) {
  const selected = [];
  const used = new Set();
  const recordsById = new Map(designs.map((design) => [design.id, design]));
  const baseline = recordsById.get(defaultShowcaseId);
  if (!baseline) throw new Error(`Default showcase design #${defaultShowcaseId} was not found.`);

  const add = (design, selectionReason) => {
    if (!design || used.has(design.id)) return false;
    used.add(design.id);
    selected.push({ design, selectionReason });
    return true;
  };

  const addFirstUnused = (candidates, compare, selectionReason) => {
    const candidate = [...candidates].sort(compare).find((design) => !used.has(design.id));
    if (!add(candidate, selectionReason)) {
      throw new Error(`Unable to select showcase category: ${selectionReason}`);
    }
  };

  const feasible = designs.filter(
    (design) => design.feasible && design.mass > 0 && design.power > 0,
  );
  const paretoFront = findParetoFront(feasible);
  const idealDistance = createIdealDistance(feasible);

  add(baseline, 'Default demonstration design');
  addFirstUnused(feasible, compareDescending((design) => design.maxDistance), 'Maximum flight distance');
  addFirstUnused(feasible.filter((design) => design.hoverTime > 0), compareDescending((design) => design.hoverTime), 'Maximum hover time');
  addFirstUnused(feasible.filter((design) => design.maxSpeed > 0), compareDescending((design) => design.maxSpeed), 'Maximum speed');
  addFirstUnused(feasible, compareAscending((design) => design.power), 'Minimum power at maximum flight distance');
  addFirstUnused(feasible.filter((design) => design.dragAt20 > 0), compareAscending((design) => design.dragAt20), 'Minimum valid drag at 20 m/s');
  addFirstUnused(paretoFront, compareAscending(idealDistance), 'Pareto-balanced Range–Power–Mass trade-off');
  addFirstUnused(feasible.filter((design) => design.numWings > 0), compareDescending((design) => design.maxDistance), 'Maximum-range winged design');
  addFirstUnused(feasible.filter((design) => design.numPropellers === 4), compareDescending((design) => design.maxDistance), 'Maximum-range 4-propeller design');
  addFirstUnused(feasible.filter((design) => design.numPropellers === 6), compareDescending((design) => design.maxDistance), 'Maximum-range 6-propeller design');
  addFirstUnused(feasible.filter((design) => design.numPropellers === 8), compareDescending((design) => design.maxDistance), 'Maximum-range 8-propeller design');
  addFirstUnused(feasible.filter((design) => design.mass <= 5 && design.hoverTime > 0), compareDescending((design) => design.hoverTime), 'Maximum hover time under 5 kg');

  return selected;
}

const dataRoots = discoverDataRoots();
if (dataRoots.length !== expectedPartCount) {
  throw new Error(
    `Expected ${expectedPartCount} AircraftVerse parts, found ${dataRoots.length}: ${dataRoots.join(', ')}`,
  );
}
fs.mkdirSync(publicDataDir, { recursive: true });
fs.mkdirSync(publicModelsDir, { recursive: true });

const designRecords = [];
const designIds = new Set();
const partSummaries = [];
const propellerCounts = new Map();
const wingCounts = new Map();

for (const dataRoot of dataRoots) {
  const folders = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name))
    .sort((a, b) => Number(a.name.slice(7)) - Number(b.name.slice(7)));
  if (folders.length !== expectedDesignsPerPart) {
    throw new Error(
      `Expected ${expectedDesignsPerPart.toLocaleString()} designs in ${dataRoot}, found ${folders.length.toLocaleString()}.`,
    );
  }
  let partBytes = 0;

  for (const folder of folders) {
    const id = Number(folder.name.slice(7));
    if (designIds.has(id)) throw new Error(`Duplicate AircraftVerse design ID: ${id}`);
    designIds.add(id);

    const designDir = path.join(dataRoot, folder.name);
    for (const fileName of requiredFiles) {
      const filePath = path.join(designDir, fileName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`Missing ${fileName} for design #${id}`);
      }
      partBytes += fs.statSync(filePath).size;
    }

    assertNpySchema(path.join(designDir, 'pointCloud.npy'), '<f4', [100, 3]);
    const trimMetadata = assertNpySchema(path.join(designDir, 'trims.npy'), '<f8', [51, 12]);
    const output = readJson(path.join(designDir, 'output.json'));
    const sequence = readJson(path.join(designDir, 'design_seq.json'));
    const lowLevel = readJson(path.join(designDir, 'design_low_level.json'));
    const components = lowLevel.components ?? [];
    const numPropellers = components.filter((component) => component.component_type === 'Propeller').length;
    const numWings = components.filter((component) => component.component_type === 'Wing').length;
    const hub = getSequenceValues(sequence, 'node_type').find((value) => String(value).startsWith('ConnectedHub')) ?? 'Unknown';
    const armLength = Number(getSequenceValue(sequence, 'armLength') ?? getSequenceValue(sequence, 'arm1Length') ?? 0);
    const trim20 = readTrimAt(trimMetadata, 20);
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
      viewerReady: false,
    };

    designRecords.push({ designDir, metadata });
    propellerCounts.set(numPropellers, (propellerCounts.get(numPropellers) ?? 0) + 1);
    wingCounts.set(numWings, (wingCounts.get(numWings) ?? 0) + 1);
  }

  partSummaries.push({
    name: path.basename(dataRoot),
    designCount: folders.length,
    bytes: partBytes,
  });
}

if (designRecords.length !== expectedTotalDesigns || designIds.size !== expectedTotalDesigns) {
  throw new Error(
    `Expected ${expectedTotalDesigns.toLocaleString()} unique designs, indexed ${designRecords.length.toLocaleString()} records and ${designIds.size.toLocaleString()} unique IDs.`,
  );
}

designRecords.sort((a, b) => a.metadata.id - b.metadata.id);
const designs = designRecords.map((record) => record.metadata);
const recordsById = new Map(designRecords.map((record) => [record.metadata.id, record]));
const selected = selectShowcases(designs);
const selectedIds = new Set(selected.map(({ design }) => design.id));
designs.forEach((design) => {
  design.viewerReady = selectedIds.has(design.id);
});

for (const fileName of fs.readdirSync(publicModelsDir)) {
  if (/^design-\d+\.stl$/.test(fileName)) {
    fs.unlinkSync(path.join(publicModelsDir, fileName));
  }
}

const showcase = {};
for (const { design, selectionReason } of selected) {
  const record = recordsById.get(design.id);
  const sequence = readJson(path.join(record.designDir, 'design_seq.json'));
  const output = readJson(path.join(record.designDir, 'output.json'));
  const modelName = `design-${design.id}.stl`;
  writeBinaryStl(
    path.join(record.designDir, 'cadfile.stl'),
    path.join(publicModelsDir, modelName),
  );
  showcase[design.id] = {
    ...design,
    selectionReason,
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
    trim: createTrimRows(path.join(record.designDir, 'trims.npy')),
    output,
  };
}

const validDesigns = designs.filter((design) => design.feasible);
const summary = {
  aircraftVerseTotal: designs.length,
  localDesigns: designs.length,
  validRangeDesigns: validDesigns.length,
  validHoverDesigns: designs.filter((design) => design.hoverTime > 0).length,
  wingedDesigns: designs.filter((design) => design.numWings > 0).length,
  sourceParts: partSummaries,
  sourceBytes: partSummaries.reduce((total, part) => total + part.bytes, 0),
  pointCloudShape: [100, 3],
  showcaseIds: selected.map(({ design }) => design.id),
  defaultShowcaseId,
  propellerDistribution: Object.fromEntries([...propellerCounts.entries()].sort((a, b) => a[0] - b[0])),
  wingDistribution: Object.fromEntries([...wingCounts.entries()].sort((a, b) => a[0] - b[0])),
  source: 'AircraftVerse complete local dataset',
  trimSchema: trimFields,
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
  `Indexed ${designs.length.toLocaleString()} designs from ${dataRoots.length} parts and prepared ${selected.length} showcase models.`,
);
console.log(`Showcase IDs: ${summary.showcaseIds.join(', ')}`);
