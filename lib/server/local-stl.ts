import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 개발자 PC에 있는 AircraftVerse 원본에서 STL을 그때그때 읽어 준다.
 *
 * 27,714개(38GB)를 저장소에 넣을 수 없고, 미리 변환해 두는 방식은 설계를 볼
 * 때마다 명령을 한 번 더 쳐야 해서 번거롭다. 원본은 어차피 로컬에 있으므로
 * 요청이 올 때 ASCII를 바이너리로 바꿔 보낸다. 실측 평균 17ms다.
 *
 * 원본 위치는 AIRCRAFTVERSE_ROOT 로 지정하거나, 지정이 없으면
 * prepare-part-placements.mjs 와 같은 자리를 훑는다. 배포 환경에는 원본이
 * 없으므로 항상 404가 난다.
 */

let cachedRoots: string[] | null = null;

function designRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  const explicit = process.env.AIRCRAFTVERSE_ROOT;
  const bases = explicit
    ? explicit.split(path.delimiter).filter(Boolean)
    : [
        path.join(process.cwd(), 'data', 'raw'),
        path.resolve(process.cwd(), '..'),
        path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Downloads'),
      ];
  const found: string[] = [];
  const holdsDesigns = (dir: string) => {
    try {
      return readdirSync(dir).some((entry) => /^design_\d+$/.test(entry));
    } catch {
      return false;
    }
  };
  for (const base of bases) {
    if (!existsSync(base)) continue;
    if (holdsDesigns(base)) { found.push(base); continue; }
    let entries: string[] = [];
    try { entries = readdirSync(base); } catch { continue; }
    for (const entry of entries) {
      const direct = path.join(base, entry);
      if (holdsDesigns(direct)) { found.push(direct); continue; }
      // `AircraftVerse_1-003/AircraftVerse_1` 처럼 한 겹 더 들어간 배치
      let nested: string[] = [];
      try { nested = readdirSync(direct); } catch { continue; }
      for (const inner of nested) {
        const deep = path.join(direct, inner);
        if (holdsDesigns(deep)) found.push(deep);
      }
    }
  }
  cachedRoots = [...new Set(found)];
  return cachedRoots;
}

/** 지수 표기(1.2e-14)의 음수 지수까지 읽어야 한다. */
const VERTEX =
  /vertex\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)/g;

/** ASCII STL을 바이너리로. 삼각형 좌표는 그대로라 품질 손실이 없다. */
function toBinaryStl(text: string): Buffer {
  const points: number[][] = [];
  VERTEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VERTEX.exec(text))) {
    const point = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (point.every(Number.isFinite)) points.push(point);
  }
  const count = Math.floor(points.length / 3);
  const out = Buffer.alloc(84 + count * 50);
  out.write('drawn local binary STL', 0, 'ascii');
  out.writeUInt32LE(count, 80);
  for (let i = 0; i < count; i += 1) {
    const at = 84 + i * 50;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        out.writeFloatLE(points[i * 3 + vertex][axis], at + 12 + vertex * 12 + axis * 4);
      }
    }
  }
  return out;
}

export async function readLocalStl(id: number): Promise<Buffer | null> {
  // 미리 변환해 둔 것이 있으면 그것을 먼저 쓴다.
  const prepared = path.join(process.cwd(), 'public', 'models', 'local', `design-${id}.stl`);
  if (existsSync(prepared)) return readFile(prepared);
  for (const root of designRoots()) {
    const source = path.join(root, `design_${id}`, 'cadfile.stl');
    if (!existsSync(source)) continue;
    return toBinaryStl(await readFile(source, 'utf8'));
  }
  return null;
}
