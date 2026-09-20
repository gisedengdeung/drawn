import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const localDataRoot = path.join(projectRoot, 'data', 'raw');
const publicDataDir = path.join(projectRoot, 'public', 'data');
const publicModelsDir = path.join(projectRoot, 'public', 'models');
const designTreesDir = path.join(publicDataDir, 'design-trees');
const defaultShowcaseId = 17297;
const shardSize = 1000;
const expectedPartCount = 3;
const expectedDesignsPerPart = 9238;
const expectedTotalDesigns = 27714;
const expectedCatalogCounts = {
  motors: 49,
  propellers: 146,
  batteries: 56,
  servos: 27,
  nacaProfiles: 68,
};
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
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory())
    return false;
  return fs
    .readdirSync(candidate, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name));
}

function resolveDesignRoot(candidate) {
  const absolute = path.resolve(candidate);
  if (hasDesignFolders(absolute)) return absolute;
  const nested = path.join(absolute, path.basename(absolute));
  if (hasDesignFolders(nested)) return nested;
  const child = fs.existsSync(absolute)
    ? fs
        .readdirSync(absolute, { withFileTypes: true })
        .find(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith('__') &&
            hasDesignFolders(path.join(absolute, entry.name)),
        )
    : null;
  if (child) return path.join(absolute, child.name);
  throw new Error(`AircraftVerse design directory not found: ${absolute}`);
}

function findDataParts(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && /^AircraftVerse_\d+$/.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry.name));
}

function discoverDataRoots() {
  const explicitRoots = parseArgs(process.argv.slice(2));
  // Select one location so legacy and project-local copies cannot be combined.
  const localParts = explicitRoots.length ? [] : findDataParts(localDataRoot);
  const candidates = explicitRoots.length
    ? explicitRoots
    : localParts.length
      ? localParts
      : findDataParts(workspaceRoot);
  if (!candidates.length) {
    throw new Error(
      `No AircraftVerse_* directories found under ${localDataRoot} or ${workspaceRoot}. Use --data-root <part-directory> for each of the three parts.`,
    );
  }
  return candidates.map(resolveDesignRoot);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getSequenceValue(sequence, key) {
  return sequence.find((entry) => Object.hasOwn(entry, key))?.[key] ?? null;
}

function readNpyHeader(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 16 || buffer.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new Error(`Invalid NPY file: ${filePath}`);
  }
  const major = buffer[6];
  const headerLength =
    major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerOffset = major === 1 ? 10 : 12;
  const header = buffer.toString(
    'latin1',
    headerOffset,
    headerOffset + headerLength,
  );
  const descr = header.match(/'descr':\s*'([^']+)'/)?.[1];
  const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1] ?? '';
  const shape = shapeText
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
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
    const rawValues = trimFields.map((field, column) => {
      const value = metadata.buffer.readDoubleLE(
        metadata.dataOffset + (speed * 12 + column) * 8,
      );
      return [field, value];
    });
    const rowHasSignal = rawValues.some(
      ([, value]) => Number.isFinite(value) && value !== 0,
    );
    const row = Object.fromEntries(
      rawValues.map(([field, value]) => {
        return [field, rowHasSignal && Number.isFinite(value) ? value : null];
      }),
    );
    const fieldValidity = Object.fromEntries(
      trimFields.map((field) => [field, row[field] !== null]),
    );
    return {
      speed,
      ...row,
      valid: rowHasSignal,
      fieldValidity,
    };
  });
}

function readTrimAt(metadata, speed) {
  const row = Array.from({ length: 12 }, (_, column) =>
    metadata.buffer.readDoubleLE(
      metadata.dataOffset + (speed * 12 + column) * 8,
    ),
  );
  const valid = row.some((value) => Number.isFinite(value) && value !== 0);
  const nullable = (value) => (valid && Number.isFinite(value) ? value : null);
  return {
    valid,
    drag:    nullable(row[6]),
    power:   nullable(row[8]),
    thrust:  nullable(row[4]),
    current: nullable(row[7]),
    lift:    nullable(row[5]),
    pitch:   nullable(row[2]),
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
    (a, b) =>
      b.maxDistance - a.maxDistance ||
      a.power - b.power ||
      a.mass - b.mass ||
      a.id - b.id,
  );
  const powers = [...new Set(sorted.map((design) => design.power))].sort(
    (a, b) => a - b,
  );
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
    for (
      let cursor = index;
      cursor < minimumMassTree.length;
      cursor += cursor & -cursor
    ) {
      minimumMassTree[cursor] = Math.min(minimumMassTree[cursor], mass);
    }
  };

  const front = [];
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (
      end < sorted.length &&
      sorted[end].maxDistance === sorted[start].maxDistance
    )
      end += 1;
    const distanceGroup = sorted.slice(start, end);
    const candidates = distanceGroup.filter((design) => {
      const index = powerIndex.get(design.power);
      return queryMinimumMass(index) > design.mass;
    });

    let minimumMassAtLowerPower = Number.POSITIVE_INFINITY;
    for (let powerStart = 0; powerStart < candidates.length;) {
      let powerEnd = powerStart + 1;
      while (
        powerEnd < candidates.length &&
        candidates[powerEnd].power === candidates[powerStart].power
      ) {
        powerEnd += 1;
      }
      const powerGroup = candidates.slice(powerStart, powerEnd);
      const minimumMassAtPower = powerGroup[0].mass;
      for (const design of powerGroup) {
        const dominatedAtSameDistance =
          minimumMassAtLowerPower <= design.mass ||
          minimumMassAtPower < design.mass;
        if (!dominatedAtSameDistance) front.push(design);
      }
      minimumMassAtLowerPower = Math.min(
        minimumMassAtLowerPower,
        minimumMassAtPower,
      );
      powerStart = powerEnd;
    }

    for (const design of distanceGroup) {
      recordMass(powerIndex.get(design.power), design.mass);
    }
    start = end;
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
  const normalize = (value, minimum, maximum) =>
    (value - minimum) / Math.max(maximum - minimum, 1);
  return (design) =>
    Math.hypot(
      1 - normalize(design.maxDistance, bounds.rangeMin, bounds.rangeMax),
      normalize(design.power, bounds.powerMin, bounds.powerMax),
      normalize(design.mass, bounds.massMin, bounds.massMax),
    );
}

function selectParetoKnee(paretoFront, feasibleDesigns) {
  if (!paretoFront.length)
    throw new Error('Cannot select a Pareto knee from an empty front.');
  const idealDistance = createIdealDistance(feasibleDesigns);
  return [...paretoFront].sort(compareAscending(idealDistance))[0];
}

function scalarParameters(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        entry === null ||
        ['number', 'string', 'boolean'].includes(typeof entry),
    ),
  );
}

function stableNodeId(pathName) {
  return pathName.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function walkTree(value, pathName, visitor) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  visitor(value, pathName);
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      walkTree(child, pathName ? `${pathName}.${key}` : key, visitor);
    }
  }
}

function naturalComponentSort(left, right) {
  return String(left.component_instance).localeCompare(
    String(right.component_instance),
    undefined,
    { numeric: true },
  );
}

function parseParameterValue(name, rawValue) {
  const text = String(rawValue ?? '');
  if (/NACA|PROFILE|TYPE/i.test(name)) return text;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

function createSourceParameters(lowLevel) {
  return (lowLevel.parameters ?? []).map((parameter, index) => {
    const name = String(
      parameter.parameter_name ?? `Parameter_${index + 1}`,
    );
    const optimization = parameter.optimization
      ? String(parameter.optimization)
      : null;
    const value = parseParameterValue(name, parameter.value);
    const targetCount = Array.isArray(parameter.component_properties)
      ? parameter.component_properties.length
      : 0;
    return [name, value, optimization, targetCount];
  });
}

function physicalComponents(lowLevel, type) {
  return (lowLevel.components ?? [])
    .filter((component) => component.component_type === type)
    .sort(naturalComponentSort)
    .map((component) => ({
      instance: String(component.component_instance),
      type: String(component.component_type),
      choice: String(component.component_choice ?? ''),
    }));
}

function createWing(wing, pathName, servoType) {
  return {
    id: `wing:${stableNodeId(pathName)}`,
    path: pathName,
    type: String(wing.wingType ?? 'Unknown'),
    nacaProfile: String(wing.nacaProfile ?? ''),
    span: Number(wing.span) || 0,
    chordInner: Number(wing.chordInner) || 0,
    chordOuter: Number(wing.chordOuter) || 0,
    taperOffset: Boolean(wing.taperOffset),
    rotation: Number(wing.rotation ?? wing.wingRot ?? wing.tubeRot) || 0,
    aileronBias: Number(wing.aileronBias) || 0,
    flapBias: Number(wing.flapBias) || 0,
    load: Number(wing.load) || 0,
    tubeOffset: Number(wing.tubeOffset) || 0,
    ...(servoType ? { servoType: String(servoType) } : {}),
  };
}

function createDesignDraft(id, tree, lowLevel, numPropellers, numWings) {
  const nodes = [];
  const segments = [];
  let propulsionGroups = [];
  const wings = [];
  const batteryTypes = new Set();
  const layoutAxes = new Map();

  walkTree(tree, '', (node, pathName) => {
    if (typeof node.node_type === 'string') {
      nodes.push({
        id: `node:${stableNodeId(pathName)}`,
        path: pathName,
        nodeType: node.node_type,
        slot: pathName.split('.').at(-1) ?? pathName,
        parameters: scalarParameters(node),
      });
    }
    if (typeof node.batteryType === 'string')
      batteryTypes.add(node.batteryType);

    if (pathName.startsWith('hub.') && typeof node.node_type === 'string') {
      const wing =
        node.wing && typeof node.wing === 'object'
          ? createWing(node.wing, `${pathName}.wing`, node.servo?.servoType)
          : undefined;
      if (wing) wings.push(wing);
      const segmentId = `segment:${stableNodeId(pathName)}`;
      const segmentParameters = {
        ...scalarParameters(node),
        ...(node.flange?.angle !== undefined
          ? { flangeAngle: Number(node.flange.angle) }
          : {}),
        ...(node.flange?.offset !== undefined
          ? { flangeOffset: Number(node.flange.offset) }
          : {}),
      };
      const segment = {
        id: segmentId,
        path: pathName,
        nodeType: node.node_type,
        slot: pathName.split('.').at(-1) ?? pathName,
        length:
          Number(node.armLength) ||
          (Number(node.arm1Length) || 0) + (Number(node.arm2Length) || 0),
        angle: Number(node.angle ?? node.flange?.angle) || 0,
        offset: Number(node.offset ?? node.flange?.offset) || 0,
        parameters: segmentParameters,
        ...(node.motor?.motorType
          ? { motorType: String(node.motor.motorType) }
          : {}),
        ...(node.prop?.propType
          ? { propellerType: String(node.prop.propType) }
          : {}),
        ...(wing ? { wing } : {}),
      };
      segments.push(segment);
      if (segment.motorType || segment.propellerType) {
        propulsionGroups.push({
          id: `propulsion:${stableNodeId(pathName)}`,
          path: pathName,
          segmentId,
          motorType: segment.motorType ?? '',
          propellerType: segment.propellerType ?? '',
        });
      }
    }
  });

  for (const segment of segments) {
    const parent = segments
      .filter(
        (candidate) =>
          candidate.path !== segment.path &&
          segment.path.startsWith(`${candidate.path}.`),
      )
      .sort((left, right) => right.path.length - left.path.length)[0];
    segment.parentPath = parent?.path ?? null;
    segment.depth = segment.path.split('.').length - 1;
  }
  // design_tree stores reusable branch templates. Multiplicity cannot be joined
  // safely by array position because design_low_level uses a different ordering.
  // The renderer derives root symmetry from topology and uses physical component
  // counts as the authoritative cardinality instead.
  segments.forEach((segment) => {
    segment.multiplicity = 1;
  });

  const physical = {
    motors: physicalComponents(lowLevel, 'Motor'),
    propellers: physicalComponents(lowLevel, 'Propeller'),
    batteries: physicalComponents(lowLevel, 'Battery'),
    wings: physicalComponents(lowLevel, 'Wing'),
    servos: physicalComponents(lowLevel, 'Servo'),
  };
  const propulsionTemplates = segments.filter(
    (segment) => segment.motorType || segment.propellerType,
  );
  const physicalGroupCount = Math.max(
    physical.motors.length,
    physical.propellers.length,
  );
  if (physicalGroupCount) {
    propulsionGroups = Array.from({ length: physicalGroupCount }, (_, index) => {
      const motor = physical.motors[index];
      const propeller = physical.propellers[index];
      const template = propulsionTemplates.length
        ? propulsionTemplates[index % propulsionTemplates.length]
        : segments[index % Math.max(segments.length, 1)];
      return {
        id: `propulsion:${motor?.instance ?? propeller?.instance ?? index + 1}`,
        path: template?.path ?? `physical.propulsion.${index}`,
        segmentId: template?.id ?? '',
        motorType: motor?.choice ?? template?.motorType ?? '',
        propellerType: propeller?.choice ?? template?.propellerType ?? '',
        ...(motor ? { motorInstance: motor.instance } : {}),
        ...(propeller ? { propellerInstance: propeller.instance } : {}),
      };
    });
  }

  if (physical.wings.length > wings.length && wings.length) {
    const templates = [...wings];
    wings.length = 0;
    physical.wings.forEach((component, index) => {
      const template = templates[index % templates.length];
      wings.push({
        ...template,
        id: `wing:${stableNodeId(component.instance)}`,
        path: `physical.${component.instance}`,
        type: component.choice || template.type,
        ...(physical.servos[index]
          ? { servoType: physical.servos[index].choice }
          : {}),
      });
    });
  }

  const fuselage = tree.fuselageWithComponents?.fuselage ?? {};
  for (const [key, value] of Object.entries(fuselage)) {
    const match = key.match(/^(.+)(X|Y)$/);
    if (!match || !Number.isFinite(Number(value))) continue;
    const name = match[1];
    const axes = layoutAxes.get(name) ?? { x: 0, y: 0 };
    axes[match[2].toLowerCase()] = Number(value);
    layoutAxes.set(name, axes);
  }
  const cargoMass =
    Number(
      lowLevel.parameters?.find(
        (parameter) => parameter.parameter_name === 'CargoMass',
      )?.value,
    ) || 0;

  return {
    baselineId: id,
    name: String(tree.name ?? `design_${id}`),
    topology: String(tree.hub?.node_type ?? 'Unknown'),
    numPropellers,
    numWings,
    nodes,
    segments,
    propulsionGroups,
    parameterDefinitions: [],
    sourceParameters: createSourceParameters(lowLevel),
    physicalComponents: physical,
    energy: {
      batteryTypes: physical.batteries.length
        ? physical.batteries.map((component) => component.choice)
        : [...batteryTypes],
      configuration: String(
        tree.fuselageWithComponents?.node_type ?? 'Unknown',
      ),
    },
    fuselage: {
      length: Number(fuselage.length) || 0,
      horizontalDiameter: Number(fuselage.horzDiameter) || 0,
      verticalDiameter: Number(fuselage.vertDiameter) || 0,
      floorHeight: Number(fuselage.floorHeight) || 0,
    },
    wings,
    payload: { mass: cargoMass },
    layout: Object.fromEntries(layoutAxes),
  };
}

function selectShowcases(designs, paretoFront, paretoKnee) {
  const selected = [];
  const used = new Set();
  const recordsById = new Map(designs.map((design) => [design.id, design]));
  const baseline = recordsById.get(defaultShowcaseId);
  if (!baseline)
    throw new Error(
      `Default showcase design #${defaultShowcaseId} was not found.`,
    );

  const add = (design, selectionReason) => {
    if (!design || used.has(design.id)) return false;
    used.add(design.id);
    selected.push({ design, selectionReason });
    return true;
  };

  const addFirstUnused = (candidates, compare, selectionReason) => {
    const candidate = [...candidates]
      .sort(compare)
      .find((design) => !used.has(design.id));
    if (!add(candidate, selectionReason)) {
      throw new Error(`Unable to select showcase category: ${selectionReason}`);
    }
  };

  const feasible = designs.filter(
    (design) => design.feasible && design.mass > 0 && design.power > 0,
  );
  add(baseline, 'Default demonstration design');
  addFirstUnused(
    feasible,
    compareDescending((design) => design.maxDistance),
    'Maximum flight distance',
  );
  addFirstUnused(
    feasible.filter((design) => design.hoverTime > 0),
    compareDescending((design) => design.hoverTime),
    'Maximum hover time',
  );
  addFirstUnused(
    feasible.filter((design) => design.maxSpeed > 0),
    compareDescending((design) => design.maxSpeed),
    'Maximum speed',
  );
  addFirstUnused(
    feasible,
    compareAscending((design) => design.power),
    'Minimum power at maximum flight distance',
  );
  addFirstUnused(
    feasible.filter((design) => design.dragAt20 > 0),
    compareAscending((design) => design.dragAt20),
    'Minimum valid drag at 20 m/s',
  );
  if (!add(paretoKnee, 'Pareto knee: Range–Power–Mass compromise')) {
    addFirstUnused(
      paretoFront,
      compareAscending(createIdealDistance(feasible)),
      'Pareto knee: Range–Power–Mass compromise',
    );
  }
  addFirstUnused(
    feasible.filter((design) => design.numWings > 0),
    compareDescending((design) => design.maxDistance),
    'Maximum-range winged design',
  );
  addFirstUnused(
    feasible.filter((design) => design.numPropellers === 4),
    compareDescending((design) => design.maxDistance),
    'Maximum-range 4-propeller design',
  );
  addFirstUnused(
    feasible.filter((design) => design.numPropellers === 6),
    compareDescending((design) => design.maxDistance),
    'Maximum-range 6-propeller design',
  );
  addFirstUnused(
    feasible.filter((design) => design.numPropellers === 8),
    compareDescending((design) => design.maxDistance),
    'Maximum-range 8-propeller design',
  );
  addFirstUnused(
    feasible.filter((design) => design.mass <= 5 && design.hoverTime > 0),
    compareDescending((design) => design.hoverTime),
    'Maximum hover time under 5 kg',
  );

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
fs.mkdirSync(designTreesDir, { recursive: true });

const designRecords = [];
const designIds = new Set();
const partSummaries = [];
const propellerCounts = new Map();
const wingCounts = new Map();
const designShards = new Map();
const catalogSets = {
  motors: new Set(),
  propellers: new Set(),
  batteries: new Set(),
  servos: new Set(),
  nacaProfiles: new Set(),
  nodeTypes: new Set(),
};

for (const dataRoot of dataRoots) {
  const folders = fs
    .readdirSync(dataRoot, { withFileTypes: true })
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
    if (designIds.has(id))
      throw new Error(`Duplicate AircraftVerse design ID: ${id}`);
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
    const trimMetadata = assertNpySchema(
      path.join(designDir, 'trims.npy'),
      '<f8',
      [51, 12],
    );
    const output = readJson(path.join(designDir, 'output.json'));
    const tree = readJson(path.join(designDir, 'design_tree.json'));
    const lowLevel = readJson(path.join(designDir, 'design_low_level.json'));
    const components = lowLevel.components ?? [];
    const numPropellers = components.filter(
      (component) => component.component_type === 'Propeller',
    ).length;
    const numWings = components.filter(
      (component) => component.component_type === 'Wing',
    ).length;
    const draft = createDesignDraft(
      id,
      tree,
      lowLevel,
      numPropellers,
      numWings,
    );
    const hub = draft.topology;
    const armLength = draft.segments[0]?.length ?? 0;
    const armLengths = draft.segments
      .map((segment) => segment.length)
      .filter((value) => value > 0);
    const wingSpans = draft.wings
      .map((wing) => wing.span)
      .filter((value) => value > 0);
    const wingChords = draft.wings
      .flatMap((wing) => [wing.chordInner, wing.chordOuter])
      .filter((value) => value > 0);
    const parameterCount = lowLevel.parameters?.length ?? 0;
    const trim20 = readTrimAt(trimMetadata, 20);
    const trim0  = readTrimAt(trimMetadata, 0);
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
      meanArmLength:
        armLengths.reduce((sum, value) => sum + value, 0) /
        Math.max(armLengths.length, 1),
      maxArmLength: Math.max(...armLengths, 0),
      fuselageLength: draft.fuselage.length,
      fuselageHorizontalDiameter: draft.fuselage.horizontalDiameter,
      fuselageVerticalDiameter: draft.fuselage.verticalDiameter,
      totalWingSpan: wingSpans.reduce((sum, value) => sum + value, 0),
      meanWingChord:
        wingChords.reduce((sum, value) => sum + value, 0) /
        Math.max(wingChords.length, 1),
      primaryMotor: draft.propulsionGroups[0]?.motorType || null,
      primaryPropeller: draft.propulsionGroups[0]?.propellerType || null,
      primaryBattery: draft.energy.batteryTypes[0] ?? null,
      dragAt20:   trim20.drag    ?? 0,
      powerAt20:  trim20.power   ?? 0,
      powerAt0:   trim0.power    ?? 0,
      thrustAt0:  trim0.thrust   ?? 0,
      currentAt0: trim0.current  ?? 0,
      feasible: Number(output.Max_Distance) > 0,
      viewerReady: false,
      paretoOptimal: false,
      parameterCount,
      shard: Math.floor(id / shardSize),
    };

    designRecords.push({ designDir, metadata, draft });
    const shard = designShards.get(metadata.shard) ?? {};
    shard[id] = draft;
    designShards.set(metadata.shard, shard);

    for (const component of components) {
      const target = {
        Motor: catalogSets.motors,
        Propeller: catalogSets.propellers,
        Battery: catalogSets.batteries,
        Servo: catalogSets.servos,
      }[component.component_type];
      if (target && component.component_choice)
        target.add(String(component.component_choice));
    }
    walkTree(tree, '', (node) => {
      if (typeof node.node_type === 'string')
        catalogSets.nodeTypes.add(node.node_type);
      if (typeof node.motorType === 'string')
        catalogSets.motors.add(node.motorType);
      if (typeof node.propType === 'string')
        catalogSets.propellers.add(node.propType);
      if (typeof node.batteryType === 'string')
        catalogSets.batteries.add(node.batteryType);
      if (typeof node.servoType === 'string')
        catalogSets.servos.add(node.servoType);
      if (typeof node.nacaProfile === 'string')
        catalogSets.nacaProfiles.add(node.nacaProfile);
    });
    propellerCounts.set(
      numPropellers,
      (propellerCounts.get(numPropellers) ?? 0) + 1,
    );
    wingCounts.set(numWings, (wingCounts.get(numWings) ?? 0) + 1);
  }

  partSummaries.push({
    name: path.basename(dataRoot),
    designCount: folders.length,
    bytes: partBytes,
  });
}

if (
  designRecords.length !== expectedTotalDesigns ||
  designIds.size !== expectedTotalDesigns
) {
  throw new Error(
    `Expected ${expectedTotalDesigns.toLocaleString()} unique designs, indexed ${designRecords.length.toLocaleString()} records and ${designIds.size.toLocaleString()} unique IDs.`,
  );
}

designRecords.sort((a, b) => a.metadata.id - b.metadata.id);
const designs = designRecords.map((record) => record.metadata);
const recordsById = new Map(
  designRecords.map((record) => [record.metadata.id, record]),
);
const validDesigns = designs.filter(
  (design) => design.feasible && design.mass > 0 && design.power > 0,
);
const paretoFront = findParetoFront(validDesigns);
const paretoIds = new Set(paretoFront.map((design) => design.id));
const paretoKnee = selectParetoKnee(paretoFront, validDesigns);
const selected = selectShowcases(designs, paretoFront, paretoKnee);
designs.forEach((design) => {
  design.paretoOptimal = paretoIds.has(design.id);
  design.viewerReady = fs.existsSync(
    path.join(publicModelsDir, `design-${design.id}.stl`),
  );
});

const catalogs = Object.fromEntries(
  Object.entries(catalogSets).map(([key, values]) => [
    key,
    [...values].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  ]),
);
for (const [catalog, expectedCount] of Object.entries(expectedCatalogCounts)) {
  if (catalogs[catalog].length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} ${catalog}, found ${catalogs[catalog].length}.`,
    );
  }
}

const showcase = {};
for (const { design, selectionReason } of selected) {
  const record = recordsById.get(design.id);
  const sequence = readJson(path.join(record.designDir, 'design_seq.json'));
  const output = readJson(path.join(record.designDir, 'output.json'));
  const modelName = `design-${design.id}.stl`;
  if (!fs.existsSync(path.join(publicModelsDir, modelName))) {
    throw new Error(
      `Showcase design #${design.id} has no deployed STL. Keep the 12-model asset set stable or update it separately.`,
    );
  }
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

for (const fileName of fs.readdirSync(designTreesDir)) {
  if (/^shard-\d{3}\.json$/.test(fileName)) {
    fs.unlinkSync(path.join(designTreesDir, fileName));
  }
}
for (const [shard, drafts] of [...designShards.entries()].sort(
  (a, b) => a[0] - b[0],
)) {
  const designCount = Object.keys(drafts).length;
  if (designCount > shardSize) {
    throw new Error(
      `Shard ${shard} contains ${designCount} designs; maximum is ${shardSize}.`,
    );
  }
  fs.writeFileSync(
    path.join(designTreesDir, `shard-${String(shard).padStart(3, '0')}.json`),
    JSON.stringify(drafts),
  );
}

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
  propellerDistribution: Object.fromEntries(
    [...propellerCounts.entries()].sort((a, b) => a[0] - b[0]),
  ),
  wingDistribution: Object.fromEntries(
    [...wingCounts.entries()].sort((a, b) => a[0] - b[0]),
  ),
  source: 'AircraftVerse complete local dataset',
  trimSchema: trimFields,
  shardSize,
  shardCount: designShards.size,
  catalogCounts: Object.fromEntries(
    Object.entries(catalogs).map(([key, values]) => [key, values.length]),
  ),
  nodeTypeCount: catalogs.nodeTypes.length,
  paretoFrontSize: paretoFront.length,
  paretoKneeId: paretoKnee.id,
  parameterCount: {
    average:
      designs.reduce((sum, design) => sum + design.parameterCount, 0) /
      designs.length,
    maximum: Math.max(...designs.map((design) => design.parameterCount)),
  },
};

fs.writeFileSync(
  path.join(publicDataDir, 'design-index.json'),
  JSON.stringify({ summary, designs }),
);
fs.writeFileSync(
  path.join(publicDataDir, 'showcase-designs.json'),
  JSON.stringify(showcase),
);
fs.writeFileSync(
  path.join(publicDataDir, 'component-catalogs.json'),
  JSON.stringify(catalogs),
);
fs.writeFileSync(
  path.join(publicDataDir, 'pareto-front.json'),
  JSON.stringify({
    objectives: {
      maximize: ['maxDistance'],
      minimize: ['power', 'mass'],
    },
    kneeMethod:
      'minimum normalized Euclidean distance to the feasible-set ideal point',
    kneeId: paretoKnee.id,
    designIds: [...paretoIds].sort((a, b) => a - b),
  }),
);

console.log(
  `Indexed ${designs.length.toLocaleString()} designs from ${dataRoots.length} parts and prepared ${designShards.size} parametric shards.`,
);
console.log(`Showcase IDs: ${summary.showcaseIds.join(', ')}`);
console.log(
  `Catalogs: ${Object.entries(summary.catalogCounts)
    .map(([key, count]) => `${key}=${count}`)
    .join(', ')}`,
);
console.log(
  `Pareto front: ${summary.paretoFrontSize} designs; knee=#${summary.paretoKneeId}.`,
);
