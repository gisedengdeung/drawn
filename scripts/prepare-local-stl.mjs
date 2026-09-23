// AircraftVerse 원본 STL(ASCII)을 바이너리로 바꿔 public/models/local/ 에 둡니다.
// 배포하지 않는 로컬 확인용입니다. 파라메트릭 형상을 원본과 1:1로 겹쳐 보려면
// 설계마다 STL이 있어야 하는데, 27,714개(38GB)를 저장소에 넣을 수는 없습니다.
//
// 사용법:
//   node scripts/prepare-local-stl.mjs 1459 17297        특정 설계
//   node scripts/prepare-local-stl.mjs --sample 50       고르게 50개
//
// 원본 위치는 prepare-part-placements.mjs 와 같은 규칙으로 찾습니다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(projectRoot, 'public', 'models', 'local');

const DOWNLOADS = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads');

function findRoots() {
  const roots = [];
  for (const base of [path.join(projectRoot, 'data', 'raw'), path.resolve(projectRoot, '..'), DOWNLOADS]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const direct = path.join(base, entry.name);
      const nested = path.join(direct, entry.name.replace(/-\d+$/, ''));
      for (const candidate of [direct, nested]) {
        if (fs.existsSync(candidate) &&
            fs.readdirSync(candidate).some((d) => /^design_\d+$/.test(d))) roots.push(candidate);
      }
    }
  }
  return [...new Set(roots)];
}

/** ASCII STL을 바이너리로. 삼각형 좌표는 그대로라 품질 손실이 없습니다. */
function toBinary(text) {
  // 지수 표기(1.2e-14)의 음수 지수까지 읽어야 한다.
  const re = /vertex\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g;
  const points = [];
  let match;
  while ((match = re.exec(text))) {
    const point = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (point.every(Number.isFinite)) points.push(point);
  }
  const count = Math.floor(points.length / 3);
  const out = Buffer.alloc(84 + count * 50);
  out.write('drawn local binary STL', 0, 'ascii');
  out.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i += 1) {
    const at = 84 + i * 50;
    for (let v = 0; v < 3; v += 1) {
      for (let k = 0; k < 3; k += 1) out.writeFloatLE(points[i * 3 + v][k], at + 12 + v * 12 + k * 4);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const roots = findRoots();
if (!roots.length) {
  console.error('AircraftVerse 원본 폴더를 찾지 못했습니다. design_* 폴더가 있는 위치에 두세요.');
  process.exit(1);
}
console.log(`원본 위치:\n${roots.map((r) => `  ${r}`).join('\n')}`);

const stlOf = new Map();
for (const root of roots) {
  for (const entry of fs.readdirSync(root)) {
    const match = entry.match(/^design_(\d+)$/);
    if (!match) continue;
    const file = path.join(root, entry, 'cadfile.stl');
    if (fs.existsSync(file) && !stlOf.has(Number(match[1]))) stlOf.set(Number(match[1]), file);
  }
}
console.log(`원본 STL ${stlOf.size.toLocaleString()}개 확인`);

let wanted;
const sampleAt = args.indexOf('--sample');
if (sampleAt >= 0) {
  const want = Number(args[sampleAt + 1] || 40);
  const all = [...stlOf.keys()].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(all.length / want));
  wanted = [];
  for (let i = 0; i < all.length && wanted.length < want; i += step) wanted.push(all[i]);
} else {
  wanted = args.map(Number).filter(Number.isFinite);
}
if (!wanted.length) {
  console.error('설계 번호를 주거나 --sample <개수> 를 쓰세요.');
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
let written = 0, bytes = 0, missing = 0;
for (const id of wanted) {
  const source = stlOf.get(id);
  if (!source) { missing += 1; continue; }
  const target = path.join(outputDir, `design-${id}.stl`);
  const binary = toBinary(fs.readFileSync(source, 'utf8'));
  fs.writeFileSync(target, binary);
  written += 1; bytes += binary.length;
  process.stdout.write(`\r  ${written}/${wanted.length} 변환   `);
}
console.log(`\n\n${written}개 저장 · ${(bytes / 1048576).toFixed(1)} MB · ${outputDir}`);
if (missing) console.log(`원본을 못 찾은 설계: ${missing}개`);
