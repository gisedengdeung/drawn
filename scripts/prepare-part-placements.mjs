// AircraftVerse의 Geom.stp(STEP AP203 조립 파일)에서 부품별 최종 좌표를 추출해
// public/data/part-placements/group-####.json 으로 저장합니다.
//
// 렌더러는 이 좌표를 그대로 사용하므로 topology 문자열로 배치를 추측할 필요가 없습니다.
// 추출 체인: NEXT_ASSEMBLY_USAGE_OCCURRENCE → PRODUCT_DEFINITION_SHAPE →
//            CONTEXT_DEPENDENT_SHAPE_REPRESENTATION → REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION →
//            ITEM_DEFINED_TRANSFORMATION → AXIS2_PLACEMENT_3D
//
// 사용법:
//   node scripts/prepare-part-placements.mjs
//   node scripts/prepare-part-placements.mjs --data-root <part-directory> (파트마다 반복)
//
// STEP 원본은 저장소에 커밋하지 않습니다. 생성된 JSON만 추적 대상입니다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(projectRoot, '..');
const localDataRoot = path.join(projectRoot, 'data', 'raw');
const outputDir = path.join(projectRoot, 'public', 'data', 'part-placements');
const indexPath = path.join(projectRoot, 'public', 'data', 'design-index.json');

// 한 파일에 묶는 설계 수. Cloudflare 무료 플랜의 정적 자산 20,000개 제한 안에서
// 설계 하나를 열 때 내려받는 양을 최소화하는 절충값입니다.
const GROUP_SIZE = 20;

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
    .filter((entry) => entry.isDirectory() && /^AircraftVerse_\d+$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => path.join(root, entry.name));
}

function discoverDataRoots() {
  const explicitRoots = parseArgs(process.argv.slice(2));
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

// ---------------------------------------------------------------- STEP 파싱

// 엔티티 이름표에 `'Placement #30579'` 같은 문자열이 들어 있어서, 따옴표 안을
// 가리지 않으면 그 숫자를 진짜 참조로 읽는다. 그 번호가 실재하는 조립관계와
// 겹치면 배치가 엉뚱한 부품에게 넘어간다(27,714개 중 573개에서 발생).
// STEP 문자열은 작은따옴표를 `''`로 이스케이프하므로 그 규칙대로 걷어낸다.
const STEP_STRING = /'[^']*(?:''[^']*)*'/g;
const refsOf = (text) =>
  [...text.replace(STEP_STRING, "''").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

function lastTuple(text) {
  const groups = text.match(/\(([^()]*)\)/g);
  return groups ? groups[groups.length - 1].slice(1, -1).split(',').map(Number) : [];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[row * 4 + k] * b[k * 4 + col];
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

function placementMatrix({ origin, zAxis, xAxis }) {
  const normalize = (v) => {
    const length = Math.hypot(...v) || 1;
    return v.map((n) => n / length);
  };
  const z = normalize(zAxis.length === 3 ? zAxis : [0, 0, 1]);
  const rawX = xAxis.length === 3 ? xAxis : [1, 0, 0];
  const projection = rawX[0] * z[0] + rawX[1] * z[1] + rawX[2] * z[2];
  const x = normalize(rawX.map((v, i) => v - projection * z[i]));
  const y = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  const o = origin.length === 3 ? origin : [0, 0, 0];
  return [
    x[0], y[0], z[0], o[0],
    x[1], y[1], z[1], o[1],
    x[2], y[2], z[2], o[2],
    0, 0, 0, 1,
  ];
}

/** STEP 조립 파일에서 부품 이름·위치·축 방향을 추출합니다. */
export function extractPlacements(stepPath) {
  const text = fs.readFileSync(stepPath, 'utf8');
  const entities = new Map();
  for (const chunk of text.slice(text.indexOf('DATA;')).split(';')) {
    const match = chunk.match(/#(\d+)\s*=\s*([\s\S]+)/);
    if (match) entities.set(Number(match[1]), match[2].replace(/\s+/g, ' ').trim());
  }

  const partName = new Map();
  for (const [id, body] of entities) {
    if (!body.startsWith('PRODUCT_DEFINITION(')) continue;
    const formation = refsOf(body)[0];
    const product = refsOf(entities.get(formation) ?? '')[0];
    const name = (entities.get(product) ?? '').match(/PRODUCT\('([^']*)'/)?.[1];
    if (name) partName.set(id, name);
  }

  const assembly = new Map();
  for (const [id, body] of entities) {
    if (!body.startsWith('NEXT_ASSEMBLY_USAGE_OCCURRENCE(')) continue;
    const [parent, child] = refsOf(body);
    assembly.set(id, { parent, child });
  }

  const shapeToAssembly = new Map();
  for (const [id, body] of entities) {
    if (!body.startsWith('PRODUCT_DEFINITION_SHAPE(')) continue;
    const target = refsOf(body).find((ref) => assembly.has(ref));
    if (target) shapeToAssembly.set(id, target);
  }

  const placement = new Map();
  for (const [, body] of entities) {
    if (!body.startsWith('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(')) continue;
    const [relationId, shapeId] = refsOf(body);
    const assemblyId = shapeToAssembly.get(shapeId);
    if (assemblyId === undefined) continue;
    const transformId = (entities.get(relationId) ?? '').match(
      /REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION\(#(\d+)\)/,
    )?.[1];
    if (!transformId) continue;
    // ITEM_DEFINED_TRANSFORMATION(name, description, parentAxis, childAxis)
    const childAxis = refsOf(entities.get(Number(transformId)) ?? '')[1];
    const [pointId, zId, xId] = refsOf(entities.get(childAxis) ?? '');
    placement.set(assemblyId, {
      origin: lastTuple(entities.get(pointId) ?? ''),
      zAxis: lastTuple(entities.get(zId) ?? ''),
      xAxis: lastTuple(entities.get(xId) ?? ''),
    });
  }

  // 부품의 실제 치수. 없으면 렌더러가 카탈로그 문자열로 크기를 추정해야 하는데,
  // 같은 설계 안에서도 프로펠러 지름이 제각각이라 그 추정은 자주 빗나간다.
  const shapeOfDefinition = new Map();
  for (const [, body] of entities) {
    if (!body.startsWith('SHAPE_DEFINITION_REPRESENTATION(')) continue;
    const [shapeId, representationId] = refsOf(body);
    const shape = entities.get(shapeId) ?? '';
    if (!shape.startsWith('PRODUCT_DEFINITION_SHAPE(')) continue;
    const definition = refsOf(shape).find((ref) => partName.has(ref));
    if (definition !== undefined) shapeOfDefinition.set(definition, representationId);
  }

  // 형상의 실제 꼭짓점(VERTEX_POINT)만 센다. 도달 가능한 CARTESIAN_POINT를 모두
  // 모으면 부품이 놓이는 기준 좌표계(AXIS2_PLACEMENT_3D)까지 딸려와 치수가
  // 몇 배로 부푼다. 예: 250mm 화물칸이 902mm로 잡혔다.
  const measure = (representationId, verticesOnly) => {
    const seen = new Set();
    const stack = [representationId];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let found = 0;
    const take = (pointId) => {
      const [x, y, z] = lastTuple(entities.get(pointId) ?? '');
      if (![x, y, z].every(Number.isFinite)) return;
      found += 1;
      [x, y, z].forEach((value, axis) => {
        if (value < lo[axis]) lo[axis] = value;
        if (value > hi[axis]) hi[axis] = value;
      });
    };
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const body = entities.get(id);
      if (!body) continue;
      if (body.startsWith('VERTEX_POINT(')) {
        take(refsOf(body)[0]);
        if (verticesOnly) continue;
      }
      if (body.startsWith('CARTESIAN_POINT(')) {
        if (!verticesOnly) take(id);
        continue;
      }
      if (body.startsWith('AXIS2_PLACEMENT_3D(')) continue;
      for (const next of refsOf(body)) stack.push(next);
    }
    if (found <= 1) return null;
    return {
      size: hi.map((value, axis) => value - lo[axis]),
      // 로컬 원점은 부품의 끝에 있을 수 있다. 날개처럼 원점이 한쪽에 치우친
      // 부품은 인스턴스마다 회전이 다르면 원점이 제각각으로 흩어져, 실제로는
      // 대칭인 배치가 비대칭으로 기록된 것처럼 보인다.
      centre: hi.map((value, axis) => (value + lo[axis]) / 2),
    };
  };

  const shapeOf = new Map();
  for (const [definition, representationId] of shapeOfDefinition) {
    // 원통·평면처럼 꼭짓점이 없는 부품은 배치 좌표계를 뺀 측정으로 되돌린다.
    const measured = measure(representationId, true) ?? measure(representationId, false);
    if (measured) shapeOf.set(definition, measured);
  }

  const childrenOf = new Map();
  for (const [id, { parent, child }] of assembly) {
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), { assemblyId: id, child }]);
  }
  const children = new Set([...assembly.values()].map((entry) => entry.child));
  const roots = [...partName.keys()].filter((definition) => !children.has(definition));

  const parts = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const round = (value) => Math.round(value * 10) / 10;
  const round3 = (value) => Math.round(value * 1000) / 1000;

  const applyTo = (matrix, point) => [0, 1, 2].map(
    (row) =>
      matrix[row * 4] * point[0] +
      matrix[row * 4 + 1] * point[1] +
      matrix[row * 4 + 2] * point[2] +
      matrix[row * 4 + 3],
  );

  const walk = (definition, matrix) => {
    const name = partName.get(definition);
    if (name) {
      const shape = shapeOf.get(definition);
      // 원점이 아니라 형상 중심을 배치 좌표로 쓴다. 원점은 부품 끝에 있을 수
      // 있어서, 같은 부품이라도 회전이 다르면 서로 다른 곳을 가리킨다.
      const placed = shape ? applyTo(matrix, shape.centre) : [matrix[3], matrix[7], matrix[11]];
      parts.push({
        n: name,
        // 위치(mm)와 부품 로컬 축의 방향. 렌더러가 회전까지 재현할 수 있습니다.
        p: placed.map(round),
        x: [round3(matrix[0]), round3(matrix[4]), round3(matrix[8])],
        z: [round3(matrix[2]), round3(matrix[6]), round3(matrix[10])],
        // 부품 로컬 좌표계 기준 실측 치수(mm).
        ...(shape ? { s: shape.size.map(round) } : {}),
      });
    }
    for (const { assemblyId, child } of childrenOf.get(definition) ?? []) {
      const local = placement.get(assemblyId);
      walk(child, local ? multiply(matrix, placementMatrix(local)) : matrix);
    }
  };
  roots.forEach((root) => walk(root, identity));

  return { parts, assemblies: assembly.size, placements: placement.size };
}

// ---------------------------------------------------------------- 실행

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const roots = discoverDataRoots();
  console.log(`Data roots:\n${roots.map((r) => `  ${r}`).join('\n')}`);

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const wanted = index.designs.map((design) => design.id).sort((a, b) => a - b);
  console.log(`Designs to process: ${wanted.length.toLocaleString()}`);

  const stepPathOf = new Map();
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.isDirectory() && entry.name.match(/^design_(\d+)$/);
      if (!match) continue;
      const id = Number(match[1]);
      if (stepPathOf.has(id)) continue;
      const candidate = path.join(root, entry.name, 'Geom.stp');
      if (fs.existsSync(candidate)) stepPathOf.set(id, candidate);
    }
  }
  console.log(`STEP files found: ${stepPathOf.size.toLocaleString()}`);

  fs.mkdirSync(outputDir, { recursive: true });
  for (const stale of fs.readdirSync(outputDir)) {
    if (stale.endsWith('.json')) fs.unlinkSync(path.join(outputDir, stale));
  }

  const started = Date.now();
  let processed = 0;
  let missing = 0;
  let failed = 0;
  let totalParts = 0;
  let group = {};
  let groupIndex = 0;

  const flush = () => {
    if (!Object.keys(group).length) return;
    const name = `group-${String(groupIndex).padStart(4, '0')}.json`;
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(group));
    group = {};
  };

  for (const id of wanted) {
    const currentGroup = Math.floor(id / GROUP_SIZE);
    if (currentGroup !== groupIndex) {
      flush();
      groupIndex = currentGroup;
    }
    const stepPath = stepPathOf.get(id);
    if (!stepPath) {
      missing += 1;
      continue;
    }
    try {
      const { parts, assemblies, placements } = extractPlacements(stepPath);
      if (!parts.length) throw new Error('no parts extracted');
      // 예전에는 한 칸 여유를 뒀는데, 딱 하나만 어긋난 설계 572개가 그 틈으로
      // 조용히 통과했다. 조립관계와 배치는 1:1이어야 한다.
      if (placements < assemblies) throw new Error(`placements ${placements} < assemblies ${assemblies}`);
      group[id] = parts;
      totalParts += parts.length;
      processed += 1;
    } catch (error) {
      failed += 1;
      if (failed <= 10) console.warn(`  #${id} failed: ${error.message}`);
    }
    if (processed % 500 === 0 && processed) {
      const rate = processed / ((Date.now() - started) / 1000);
      const remaining = (wanted.length - processed - missing - failed) / rate;
      process.stdout.write(
        `\r  ${processed.toLocaleString()} done · ${rate.toFixed(0)}/s · ETA ${(remaining / 60).toFixed(1)}min   `,
      );
    }
  }
  flush();

  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.json'));
  const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(outputDir, f)).size, 0);
  console.log('');
  console.log(
    `Wrote ${processed.toLocaleString()} designs · ${totalParts.toLocaleString()} parts · ` +
    `${files.length.toLocaleString()} files · ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
  if (missing) console.log(`Missing STEP files: ${missing.toLocaleString()}`);
  if (failed) console.log(`Failed to parse: ${failed.toLocaleString()}`);
  console.log(`Elapsed: ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
}
