/**
 * 실제 파라메트릭 뷰어 출력과 AircraftVerse 원본 STL을 전수 비교한다.
 *
 * 기본 실행:
 *   npm run geometry:audit
 * 빠른 확인:
 *   npm run geometry:audit -- --ids 1459,13077,11654
 *   npm run geometry:audit -- --sample 100
 * 회귀 비교:
 *   npm run geometry:audit -- --sample 100 --baseline outputs/geometry-audit/previous.json
 *
 * 결과는 gitignore 된 outputs/geometry-audit/ 아래 JSON과 CSV로 저장한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputRoot = path.join(projectRoot, 'outputs', 'geometry-audit');
const SCALE = 0.01;
const DEFAULT_RESOLUTION = 48;
const PROJECTIONS = [
  [0, 1],
  [0, 2],
  [1, 2],
];

function parseArgs(argv) {
  const options = {
    roots: [],
    ids: [],
    sample: 0,
    limit: 0,
    resolution: DEFAULT_RESOLUTION,
    output: null,
    baseline: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      index += 1;
      return value;
    };
    if (argument === '--stl-root') options.roots.push(path.resolve(next()));
    else if (argument === '--ids')
      options.ids.push(...next().split(',').map(Number));
    else if (argument === '--sample') options.sample = Number(next());
    else if (argument === '--limit') options.limit = Number(next());
    else if (argument === '--resolution') options.resolution = Number(next());
    else if (argument === '--output') options.output = path.resolve(next());
    else if (argument === '--baseline') options.baseline = path.resolve(next());
    else if (/^\d+$/.test(argument)) options.ids.push(Number(argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  options.ids = [...new Set(options.ids.filter(Number.isInteger))];
  if (
    !Number.isInteger(options.resolution) ||
    options.resolution < 24 ||
    options.resolution > 128
  ) {
    throw new Error('--resolution must be an integer from 24 to 128.');
  }
  return options;
}

function hasDesignFolders(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory())
    return false;
  return fs
    .readdirSync(candidate, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name));
}

function resolveRoot(candidate) {
  if (hasDesignFolders(candidate)) return candidate;
  if (!fs.existsSync(candidate)) return null;
  const child = fs
    .readdirSync(candidate, { withFileTypes: true })
    .find(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('__') &&
        hasDesignFolders(path.join(candidate, entry.name)),
    );
  return child ? path.join(candidate, child.name) : null;
}

function discoverRoots(explicit) {
  if (explicit.length) return explicit.map(resolveRoot).filter(Boolean);
  const downloads = path.join(
    process.env.USERPROFILE || process.env.HOME || '.',
    'Downloads',
  );
  const bases = [path.join(projectRoot, 'data', 'raw'), downloads];
  const roots = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('AircraftVerse_'))
        continue;
      const root = resolveRoot(path.join(base, entry.name));
      if (root) roots.push(root);
    }
  }
  return [...new Set(roots)];
}

function stlIndex(roots) {
  const result = new Map();
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.isDirectory() && entry.name.match(/^design_(\d+)$/);
      if (!match) continue;
      const file = path.join(root, entry.name, 'cadfile.stl');
      if (fs.existsSync(file)) result.set(Number(match[1]), file);
    }
  }
  return result;
}

function projectIds() {
  const ids = [];
  const directory = path.join(projectRoot, 'public', 'data', 'design-trees');
  for (const file of fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const shard = JSON.parse(
      fs.readFileSync(path.join(directory, file), 'utf8'),
    );
    ids.push(...Object.keys(shard).map(Number));
  }
  return ids.sort((a, b) => a - b);
}

function selectIds(all, options) {
  let selected = options.ids.length
    ? options.ids.filter((id) => all.includes(id))
    : all;
  if (options.sample > 0 && selected.length > options.sample) {
    const sampled = [];
    for (let index = 0; index < options.sample; index += 1) {
      sampled.push(
        selected[
          Math.floor(
            (index * (selected.length - 1)) / Math.max(options.sample - 1, 1),
          )
        ],
      );
    }
    selected = [...new Set(sampled)];
  }
  if (options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

function parseStl(buffer) {
  const binaryCount = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
  const binary = binaryCount > 0 && 84 + binaryCount * 50 === buffer.length;
  const triangles = new Float32Array(
    (binary ? binaryCount : countAsciiTriangles(buffer)) * 9,
  );
  if (binary) {
    for (let triangle = 0; triangle < binaryCount; triangle += 1) {
      const start = 84 + triangle * 50 + 12;
      for (let value = 0; value < 9; value += 1) {
        triangles[triangle * 9 + value] = buffer.readFloatLE(start + value * 4);
      }
    }
  } else {
    const text = buffer.toString('utf8');
    const re =
      /vertex\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g;
    let match;
    let at = 0;
    while ((match = re.exec(text)) && at < triangles.length) {
      triangles[at++] = Number(match[1]) * SCALE;
      triangles[at++] = Number(match[3]) * SCALE;
      triangles[at++] = -Number(match[2]) * SCALE;
    }
    return triangles;
  }
  // STL 뷰어와 같은 X, Z, -Y 축 변환과 mm → scene scale.
  for (let at = 0; at < triangles.length; at += 3) {
    const y = triangles[at + 1];
    const z = triangles[at + 2];
    triangles[at] *= SCALE;
    triangles[at + 1] = z * SCALE;
    triangles[at + 2] = -y * SCALE;
  }
  return triangles;
}

function countAsciiTriangles(buffer) {
  const text = buffer.toString('utf8');
  let vertices = 0;
  let offset = 0;
  while ((offset = text.indexOf('vertex', offset)) >= 0) {
    vertices += 1;
    offset += 6;
  }
  return Math.floor(vertices / 3);
}

function groupTriangles(group) {
  const values = [];
  group.updateWorldMatrix(true, true);
  group.traverse((node) => {
    if (!node.isMesh || !node.geometry?.getAttribute('position')) return;
    const position = node.geometry.getAttribute('position');
    const index = node.geometry.index;
    const count = index ? index.count : position.count;
    const vector = node.position.clone();
    for (let at = 0; at + 2 < count; at += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = index ? index.getX(at + corner) : at + corner;
        vector
          .fromBufferAttribute(position, vertex)
          .applyMatrix4(node.matrixWorld);
        values.push(vector.x, vector.y, vector.z);
      }
    }
  });
  return Float32Array.from(values);
}

function boundsOf(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < triangles.length; at += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = triangles[at + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  const size = min.map((value, axis) => max[axis] - value);
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  return { min, max, size, center };
}

function rasterize(triangles, axes, domain, resolution) {
  const mask = new Uint8Array(resolution * resolution);
  const [axisX, axisY] = axes;
  const spanX = Math.max(domain.max[axisX] - domain.min[axisX], 1e-6);
  const spanY = Math.max(domain.max[axisY] - domain.min[axisY], 1e-6);
  const point = (at) => [
    ((triangles[at + axisX] - domain.min[axisX]) / spanX) * (resolution - 1),
    ((triangles[at + axisY] - domain.min[axisY]) / spanY) * (resolution - 1),
  ];
  for (let at = 0; at + 8 < triangles.length; at += 9) {
    const a = point(at),
      b = point(at + 3),
      c = point(at + 6);
    fillTriangle(mask, resolution, a, b, c);
  }
  return dilate(mask, resolution);
}

function fillTriangle(mask, resolution, a, b, c) {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(resolution - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(resolution - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const area = edge(a, b, c[0], c[1]);
  if (Math.abs(area) < 1e-5) {
    drawLine(mask, resolution, a, b);
    drawLine(mask, resolution, b, c);
    drawLine(mask, resolution, c, a);
    return;
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w0 = edge(b, c, x + 0.5, y + 0.5);
      const w1 = edge(c, a, x + 0.5, y + 0.5);
      const w2 = edge(a, b, x + 0.5, y + 0.5);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        mask[y * resolution + x] = 1;
      }
    }
  }
}

function edge(a, b, x, y) {
  return (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
}

function drawLine(mask, resolution, a, b) {
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))),
  );
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * step) / steps);
    const y = Math.round(a[1] + ((b[1] - a[1]) * step) / steps);
    if (x >= 0 && x < resolution && y >= 0 && y < resolution)
      mask[y * resolution + x] = 1;
  }
}

function dilate(mask, resolution) {
  const result = mask.slice();
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      if (!mask[y * resolution + x]) continue;
      for (let dy = -1; dy <= 1; dy += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          const px = x + dx,
            py = y + dy;
          if (px >= 0 && px < resolution && py >= 0 && py < resolution)
            result[py * resolution + px] = 1;
        }
    }
  }
  return result;
}

function iou(left, right) {
  let intersection = 0,
    union = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] || right[index]) union += 1;
    if (left[index] && right[index]) intersection += 1;
  }
  return union ? intersection / union : 1;
}

function compareGeometry(parametric, original, resolution) {
  const p = boundsOf(parametric),
    o = boundsOf(original);
  const domain = {
    min: p.min.map((value, axis) => Math.min(value, o.min[axis])),
    max: p.max.map((value, axis) => Math.max(value, o.max[axis])),
  };
  const extentDelta = p.size.map(
    (value, axis) => (value - o.size[axis]) / Math.max(o.size[axis], 1e-6),
  );
  const extentError = extentDelta.map(Math.abs);
  const diagonal = Math.hypot(...o.size) || 1;
  const centerError =
    Math.hypot(...p.center.map((value, axis) => value - o.center[axis])) /
    diagonal;
  const silhouettes = PROJECTIONS.map((axes) =>
    iou(
      rasterize(parametric, axes, domain, resolution),
      rasterize(original, axes, domain, resolution),
    ),
  );
  const maxExtentError = Math.max(...extentError);
  const minSilhouetteIou = Math.min(...silhouettes);
  const shapeError =
    1 - silhouettes.reduce((sum, value) => sum + value, 0) / silhouettes.length;
  const score = Math.max(
    0,
    100 * (1 - (maxExtentError * 0.42 + centerError * 0.18 + shapeError * 0.4)),
  );
  const issues = [];
  if (maxExtentError > 0.25) issues.push('EXTENT_SEVERE');
  else if (maxExtentError > 0.1) issues.push('EXTENT_MISMATCH');
  if (centerError > 0.12) issues.push('CENTER_SEVERE');
  else if (centerError > 0.05) issues.push('CENTER_OFFSET');
  if (minSilhouetteIou < 0.4) issues.push('SHAPE_SEVERE');
  else if (minSilhouetteIou < 0.62) issues.push('SHAPE_MISMATCH');
  const dimensions = ['WIDTH', 'HEIGHT', 'DEPTH'];
  extentDelta.forEach((delta, axis) => {
    if (delta > 0.1) issues.push(`OVERSIZE_${dimensions[axis]}`);
    else if (delta < -0.1) issues.push(`UNDERSIZE_${dimensions[axis]}`);
  });
  const grade =
    maxExtentError <= 0.05 && centerError <= 0.025 && minSilhouetteIou >= 0.78
      ? 'A'
      : maxExtentError <= 0.1 && centerError <= 0.05 && minSilhouetteIou >= 0.62
        ? 'B'
        : maxExtentError <= 0.25 &&
            centerError <= 0.12 &&
            minSilhouetteIou >= 0.4
          ? 'C'
          : 'D';
  return {
    grade,
    score: round(score),
    issues,
    extentDelta: extentDelta.map(round),
    extentError: extentError.map(round),
    maxExtentError: round(maxExtentError),
    centerError: round(centerError),
    silhouettes: silhouettes.map(round),
    minSilhouetteIou: round(minSilhouetteIou),
    parametricSizeMm: p.size.map((value) => round(value / SCALE, 1)),
    originalSizeMm: o.size.map((value) => round(value / SCALE, 1)),
  };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function componentSummary(assembly) {
  const models = { motors: new Set(), propellers: new Set(), wings: new Set() };
  for (const part of assembly.placements) {
    const model = assembly.modelOf.get(part.n);
    if (!model) continue;
    if (/^MOTOR/i.test(part.n)) models.motors.add(model);
    else if (/^PROPELLER/i.test(part.n)) models.propellers.add(model);
    else if (/^WING/i.test(part.n)) models.wings.add(model);
  }
  return Object.fromEntries(
    Object.entries(models).map(([key, values]) => [
      key,
      [...values].sort((left, right) => left.localeCompare(right)),
    ]),
  );
}

function dispose(group) {
  const materials = new Set();
  group.traverse((node) => {
    node.geometry?.dispose?.();
    const list = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of list) if (material) materials.add(material);
  });
  for (const material of materials) material.dispose?.();
}

function aggregate(rows, missing) {
  const grades = { A: 0, B: 0, C: 0, D: 0, ERROR: 0 };
  const issues = {};
  for (const row of rows) {
    grades[row.grade] = (grades[row.grade] || 0) + 1;
    for (const issue of row.issues || [])
      issues[issue] = (issues[issue] || 0) + 1;
  }
  return {
    audited: rows.length,
    missingStl: missing.length,
    grades,
    issues,
    averageScore: round(
      rows.reduce((sum, row) => sum + (row.score || 0), 0) /
        Math.max(rows.length, 1),
      2,
    ),
  };
}

function componentPatterns(rows) {
  const result = {};
  for (const kind of ['motors', 'propellers', 'wings']) {
    const models = new Map();
    for (const row of rows) {
      for (const model of row.components?.[kind] || []) {
        const stats = models.get(model) || {
          designs: 0,
          review: 0,
          severe: 0,
          score: 0,
        };
        stats.designs += 1;
        stats.review += Number(row.grade === 'C' || row.grade === 'D');
        stats.severe += Number(row.grade === 'D');
        stats.score += row.score;
        models.set(model, stats);
      }
    }
    result[kind] = [...models]
      .map(([model, stats]) => ({
        model,
        designs: stats.designs,
        reviewRate: round(stats.review / stats.designs),
        severeRate: round(stats.severe / stats.designs),
        averageScore: round(stats.score / stats.designs, 2),
      }))
      .sort(
        (left, right) =>
          right.severeRate - left.severeRate ||
          right.reviewRate - left.reviewRate ||
          right.designs - left.designs,
      );
  }
  return result;
}

function regression(current, baselinePath) {
  if (!baselinePath) return null;
  const previous = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const byId = new Map(previous.designs.map((row) => [row.id, row]));
  const worse = [],
    better = [];
  const rank = { A: 0, B: 1, C: 2, D: 3, ERROR: 4 };
  for (const row of current) {
    const before = byId.get(row.id);
    if (!before) continue;
    if (rank[row.grade] > rank[before.grade] || row.score < before.score - 3)
      worse.push({
        id: row.id,
        before: before.grade,
        after: row.grade,
        scoreDelta: round(row.score - before.score, 2),
      });
    if (rank[row.grade] < rank[before.grade] || row.score > before.score + 3)
      better.push({
        id: row.id,
        before: before.grade,
        after: row.grade,
        scoreDelta: round(row.score - before.score, 2),
      });
  }
  return { regressions: worse, improvements: better };
}

function csv(rows) {
  const columns = [
    'id',
    'grade',
    'score',
    'topology',
    'partCount',
    'numPropellers',
    'numWings',
    'issues',
    'maxExtentError',
    'centerError',
    'minSilhouetteIou',
    'motors',
    'propellers',
    'wings',
  ];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    columns.join(','),
    ...rows.map((row) =>
      columns
        .map((key) => {
          const value = key in row ? row[key] : row.components?.[key];
          return escape(Array.isArray(value) ? value.join('|') : value);
        })
        .join(','),
    ),
  ].join('\n');
}

function markdown(report) {
  const { summary } = report;
  const lines = [
    '# Parametric geometry audit',
    '',
    `- 생성: ${report.createdAt}`,
    `- 검사: ${summary.audited.toLocaleString()}개`,
    `- 원본 STL 누락: ${summary.missingStl.toLocaleString()}개`,
    `- 평균 점수: ${summary.averageScore}`,
    '',
    '## 등급',
    '',
    '| A | B | C | D | ERROR |',
    '|---:|---:|---:|---:|---:|',
    `| ${summary.grades.A} | ${summary.grades.B} | ${summary.grades.C} | ${summary.grades.D} | ${summary.grades.ERROR} |`,
    '',
    '## 문제 코드',
    '',
    ...Object.entries(summary.issues)
      .sort((a, b) => b[1] - a[1])
      .map(([issue, count]) => `- ${issue}: ${count.toLocaleString()}`),
    '',
    '## 우선 확인 설계',
    '',
    '| ID | 등급 | 점수 | 최대 외곽 오차 | 실루엣 IoU | 문제 |',
    '|---:|:---:|---:|---:|---:|---|',
    ...report.designs
      .slice(0, 30)
      .map(
        (row) =>
          `| #${row.id} | ${row.grade} | ${row.score} | ${(row.maxExtentError * 100).toFixed(1)}% | ${row.minSilhouetteIou} | ${(row.issues || []).join(', ')} |`,
      ),
    '',
    '## 반복 부품 모델 상관관계',
    '',
    '> 이 표는 원인 확정이 아니라 함께 나타난 비율이다. 설계 수가 적은 모델은 표본 효과를 주의한다.',
    '',
  ];
  for (const kind of ['motors', 'propellers', 'wings']) {
    lines.push(
      `### ${kind}`,
      '',
      '| 모델 | 설계 | C+D | D | 평균 점수 |',
      '|---|---:|---:|---:|---:|',
    );
    for (const row of report.patterns[kind]
      .filter((item) => item.designs >= 25)
      .slice(0, 15)) {
      lines.push(
        `| ${row.model} | ${row.designs} | ${(row.reviewRate * 100).toFixed(1)}% | ${(row.severeRate * 100).toFixed(1)}% | ${row.averageScore} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const roots = discoverRoots(options.roots);
  if (!roots.length)
    throw new Error(
      'AircraftVerse 원본 폴더를 찾지 못했습니다. --stl-root를 지정하세요.',
    );
  const stls = stlIndex(roots);
  const allIds = projectIds();
  const ids = selectIds(allIds, options);
  console.log(
    `원본 STL ${stls.size.toLocaleString()}개 · 감사 대상 ${ids.length.toLocaleString()}개 · 실루엣 ${options.resolution}²`,
  );

  const server = await createServer({
    root: projectRoot,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  const [
    { buildAircraftForAudit },
    { hydrateDraft },
    { resolveAssembly },
    { registerComponentMesh },
  ] =
    await Promise.all([
      server.ssrLoadModule('/components/parametric-uav-viewer.tsx'),
      server.ssrLoadModule('/lib/design-draft.ts'),
      server.ssrLoadModule('/lib/assembly.ts'),
      server.ssrLoadModule('/lib/component-meshes.ts'),
    ]);
  const componentMeshDir = path.join(
    projectRoot,
    'public',
    'data',
    'component-meshes',
  );
  const componentMeshIndexPath = path.join(componentMeshDir, 'index.json');
  if (fs.existsSync(componentMeshIndexPath)) {
    const componentMeshIndex = JSON.parse(
      fs.readFileSync(componentMeshIndexPath, 'utf8'),
    );
    for (const [model, record] of Object.entries(componentMeshIndex.models)) {
      registerComponentMesh(
        model,
        fs.readFileSync(path.join(componentMeshDir, record.file)),
      );
    }
    console.log(
      `정밀 부품 메시 ${Object.keys(componentMeshIndex.models).length.toLocaleString()}종 적용`,
    );
  }
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, 'public', 'data', 'part-catalog.json'),
      'utf8',
    ),
  );
  const cache = new Map();
  const readCached = (file) => {
    if (!cache.has(file)) {
      cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return cache.get(file);
  };
  const rows = [],
    missing = [];
  const started = Date.now();
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      const source = stls.get(id);
      if (!source) {
        missing.push(id);
        continue;
      }
      try {
        const shard = String(Math.floor(id / 1000)).padStart(3, '0');
        const group = String(Math.floor(id / 20)).padStart(4, '0');
        const drafts = readCached(
          path.join(
            projectRoot,
            'public',
            'data',
            'design-trees',
            `shard-${shard}.json`,
          ),
        );
        const placements = readCached(
          path.join(
            projectRoot,
            'public',
            'data',
            'part-placements',
            `group-${group}.json`,
          ),
        );
        const draft = hydrateDraft(drafts[String(id)]);
        const assembly = resolveAssembly(placements[String(id)], catalog);
        if (!draft || !assembly) throw new Error('draft or placement missing');
        const model = buildAircraftForAudit(draft, assembly, 2);
        const result = compareGeometry(
          groupTriangles(model),
          parseStl(fs.readFileSync(source)),
          options.resolution,
        );
        rows.push({
          id,
          ...result,
          topology: draft.topology,
          partCount: assembly.placements.length,
          numPropellers: draft.numPropellers,
          numWings: draft.numWings,
          components: componentSummary(assembly),
        });
        dispose(model);
      } catch (error) {
        rows.push({
          id,
          grade: 'ERROR',
          score: 0,
          issues: ['AUDIT_ERROR'],
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((index + 1) % 25 === 0 || index + 1 === ids.length) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = (index + 1) / Math.max(elapsed, 0.1);
        const remaining = (ids.length - index - 1) / Math.max(rate, 0.01);
        process.stdout.write(
          `\r${String(index + 1).padStart(String(ids.length).length)}/${ids.length} · ${rate.toFixed(1)}/s · 남은 시간 약 ${Math.ceil(remaining / 60)}분   `,
        );
      }
    }
  } finally {
    await server.close();
  }
  console.log('');
  rows.sort((a, b) => a.score - b.score || a.id - b.id);
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: { resolution: options.resolution, roots, requested: ids.length },
    summary: aggregate(rows, missing),
    patterns: componentPatterns(rows),
    regression: regression(rows, options.baseline),
    missingStlIds: missing,
    designs: rows,
  };
  fs.mkdirSync(outputRoot, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
  const output = options.output || path.join(outputRoot, `audit-${stamp}.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  fs.writeFileSync(output.replace(/\.json$/i, '.csv'), csv(rows));
  fs.writeFileSync(output.replace(/\.json$/i, '.md'), markdown(report));
  fs.writeFileSync(
    path.join(outputRoot, 'latest.json'),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(outputRoot, 'latest-summary.md'),
    markdown(report),
  );
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`결과: ${output}`);
  if (report.regression?.regressions.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
