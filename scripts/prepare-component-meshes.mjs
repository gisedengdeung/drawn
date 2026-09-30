// AircraftVerse 조립 STEP에서 고정 부품 모델의 실제 메시를 한 번씩 추출한다.
// 현재 1단계는 모터와 프로펠러를 만든다. 날개·암·동체처럼 설계 파라미터에 따라
// 형상이 달라지는 부품은 고정 자산으로 만들지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import occtImport from 'occt-import-js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(projectRoot, 'public', 'data', 'component-meshes');
const placementDir = path.join(projectRoot, 'public', 'data', 'part-placements');
const catalog = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'public', 'data', 'part-catalog.json'), 'utf8'),
);
const SCALE = 0.01;
const INCLUDED_TYPES = new Set(['Motor', 'Propeller']);
const EXACT_INSTANCE_TYPES = new Set(['Motor', 'Propeller', 'Wing']);
// 플랜 B 전환 전까지 원본 형상을 반드시 보존해야 하는 확인용 설계.
// 모델 표준 메시나 placement 크기 추정을 거치지 않고 인스턴스를 직접 싣는다.
const EXACT_INSTANCE_DESIGNS = new Set([11654]);

function hasDesignFolders(candidate) {
  return (
    fs.existsSync(candidate) &&
    fs
      .readdirSync(candidate, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^design_\d+$/.test(entry.name))
  );
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

function rootsFromArgs() {
  const explicit = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== '--data-root') continue;
    if (!process.argv[index + 1]) throw new Error('--data-root requires a path.');
    explicit.push(path.resolve(process.argv[index + 1]));
    index += 1;
  }
  if (explicit.length) return explicit.map(resolveRoot).filter(Boolean);
  const downloads = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');
  if (!fs.existsSync(downloads)) return [];
  return fs
    .readdirSync(downloads, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('AircraftVerse_'))
    .map((entry) => resolveRoot(path.join(downloads, entry.name)))
    .filter(Boolean);
}

function stepIndex(roots) {
  const result = new Map();
  for (const root of roots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.isDirectory() && entry.name.match(/^design_(\d+)$/);
      if (!match) continue;
      const file = path.join(root, entry.name, 'Geom.stp');
      if (fs.existsSync(file)) result.set(Number(match[1]), file);
    }
  }
  return result;
}

function representatives() {
  const result = new Map();
  const files = fs
    .readdirSync(placementDir)
    .filter((file) => file.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    const group = JSON.parse(fs.readFileSync(path.join(placementDir, file), 'utf8'));
    for (const [id, assembly] of Object.entries(group)) {
      assembly.p.forEach((part, index) => {
        const type = catalog.types[assembly.t?.[index]];
        const model = catalog.models[assembly.m?.[index]];
        if (!INCLUDED_TYPES.has(type) || !model) return;
        // 모델마다 처음 발견한 정상 형상을 표준 메시로 쓴다. 같은 설계의
        // placement 크기는 브라우저에서 균일 배율로 반영한다. 크기별 STEP
        // 노드를 별도 형상으로 취급하면 #11654처럼 손상된 거대 원통 노드가
        // 정상 모델 메시를 덮어쓴다.
        if (result.has(model)) return;
        result.set(model, { id: Number(id), part, type, model });
      });
    }
  }
  return result;
}

function placementDesigns(ids) {
  const result = new Map();
  for (const file of fs.readdirSync(placementDir).filter((name) => name.endsWith('.json'))) {
    const group = JSON.parse(fs.readFileSync(path.join(placementDir, file), 'utf8'));
    for (const id of ids) {
      const assembly = group[String(id)];
      if (assembly) result.set(id, assembly);
    }
    if (result.size === ids.size) break;
  }
  return result;
}

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function nodesOf(root) {
  const result = [];
  const visit = (node) => {
    result.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return result;
}

function extractMesh(result, node, part) {
  const x = normalize(part.x);
  const z = normalize(part.z);
  const y = normalize(cross(z, x));
  const positions = [];
  const normals = [];
  const indices = [];
  for (const meshIndex of node.meshes) {
    const mesh = result.meshes[meshIndex];
    const sourcePositions = mesh.attributes.position.array;
    const sourceNormals = mesh.attributes.normal?.array;
    const offset = positions.length / 3;
    for (let at = 0; at < sourcePositions.length; at += 3) {
      const delta = [
        sourcePositions[at] - part.p[0],
        sourcePositions[at + 1] - part.p[1],
        sourcePositions[at + 2] - part.p[2],
      ];
      positions.push(dot(delta, x) * SCALE, dot(delta, y) * SCALE, dot(delta, z) * SCALE);
      const normal = sourceNormals
        ? [sourceNormals[at], sourceNormals[at + 1], sourceNormals[at + 2]]
        : [0, 1, 0];
      normals.push(dot(normal, x), dot(normal, y), dot(normal, z));
    }
    for (const index of mesh.index.array) indices.push(offset + index);
  }
  return { positions, normals, indices };
}

function encodeMesh(mesh) {
  const vertexCount = mesh.positions.length / 3;
  const bytes = Buffer.alloc(16 + mesh.positions.length * 4 + mesh.normals.length * 4 + mesh.indices.length * 4);
  bytes.write('DCM1', 0, 'ascii');
  bytes.writeUInt32LE(vertexCount, 4);
  bytes.writeUInt32LE(mesh.indices.length, 8);
  let at = 16;
  for (const value of mesh.positions) { bytes.writeFloatLE(value, at); at += 4; }
  for (const value of mesh.normals) { bytes.writeFloatLE(value, at); at += 4; }
  for (const value of mesh.indices) { bytes.writeUInt32LE(value, at); at += 4; }
  return bytes;
}

async function main() {
  const roots = rootsFromArgs();
  if (!roots.length) throw new Error('AircraftVerse 원본 폴더를 찾지 못했습니다.');
  // placement 전체를 훑은 뒤 WASM을 초기화하면 Windows에서 연속 메모리 확보가
  // 실패할 수 있다. 큰 JSON을 읽기 전에 CAD 커널 메모리를 먼저 잡아 둔다.
  const occt = await occtImport();
  console.log('CAD 커널 준비 완료');
  const steps = stepIndex(roots);
  console.log(`STEP 색인 ${steps.size.toLocaleString()}개`);
  const reps = representatives();
  console.log(`표준 부품 모델 ${reps.size.toLocaleString()}개`);
  const previousIndexFile = path.join(outputDir, 'index.json');
  const previousRecords = fs.existsSync(previousIndexFile)
    ? JSON.parse(fs.readFileSync(previousIndexFile, 'utf8')).models ?? {}
    : {};
  const records = {};
  fs.mkdirSync(outputDir, { recursive: true });
  let completed = 0;
  for (const [model, representative] of [...reps].sort((a, b) => a[0].localeCompare(b[0]))) {
    const previous = previousRecords[model];
    if (previous?.file && fs.existsSync(path.join(outputDir, previous.file))) {
      records[model] = previous;
      completed += 1;
      process.stdout.write(`\r${completed}/${reps.size} ${representative.model}   `);
      continue;
    }
    const step = steps.get(representative.id);
    if (!step) throw new Error(`STEP missing for design #${representative.id}`);
    const result = occt.ReadStepFile(fs.readFileSync(step), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    if (!result.success) throw new Error(`STEP import failed for design #${representative.id}`);
    const node = nodesOf(result.root).find((candidate) => candidate.name === representative.part.n);
    if (!node?.meshes?.length) throw new Error(`Part ${representative.part.n} not found in #${representative.id}`);
    const mesh = extractMesh(result, node, representative.part);
    const modelIndex = catalog.models.indexOf(representative.model);
    const file = `model-${String(modelIndex).padStart(3, '0')}.bin`;
    fs.writeFileSync(path.join(outputDir, file), encodeMesh(mesh));
    records[model] = {
      file,
      type: representative.type,
      sourceDesignId: representative.id,
      sourcePart: representative.part.n,
      vertexCount: mesh.positions.length / 3,
      triangleCount: mesh.indices.length / 3,
    };
    completed += 1;
    process.stdout.write(`\r${completed}/${reps.size} ${representative.model}   `);
  }

  const exactAssemblies = placementDesigns(EXACT_INSTANCE_DESIGNS);
  for (const designId of EXACT_INSTANCE_DESIGNS) {
    const assembly = exactAssemblies.get(designId);
    const step = steps.get(designId);
    if (!assembly || !step) throw new Error(`Exact design #${designId} missing.`);
    const result = occt.ReadStepFile(fs.readFileSync(step), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.001,
      angularDeflection: 0.5,
    });
    if (!result.success) throw new Error(`STEP import failed for design #${designId}`);
    const nodes = nodesOf(result.root);
    let instanceCount = 0;
    for (let partIndex = 0; partIndex < assembly.p.length; partIndex += 1) {
      const part = assembly.p[partIndex];
      const type = catalog.types[assembly.t?.[partIndex]];
      if (!EXACT_INSTANCE_TYPES.has(type)) continue;
      const node = nodes.find((candidate) => candidate.name === part.n);
      if (!node?.meshes?.length) throw new Error(`Part ${part.n} not found in #${designId}`);
      const mesh = extractMesh(result, node, part);
      const safePart = part.n.replace(/[^a-z0-9_-]/gi, '_');
      const file = `design-${designId}-${safePart}.bin`;
      fs.writeFileSync(path.join(outputDir, file), encodeMesh(mesh));
      records[`design:${designId}:part:${part.n}`] = {
        file,
        type,
        sourceDesignId: designId,
        sourcePart: part.n,
        vertexCount: mesh.positions.length / 3,
        triangleCount: mesh.indices.length / 3,
      };
      instanceCount += 1;
    }
    console.log(`\n#${designId} 원본 인스턴스 메시 ${instanceCount}개 추가`);
  }

  const index = { version: 5, generatedAt: new Date().toISOString(), models: records };
  fs.writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify(index));
  console.log(`\n고정 부품 실제 메시 ${completed}종 생성 · ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
