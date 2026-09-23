// 프로펠러 좌표에서 "생김새 분류"를 미리 계산해 public/data/shape-classes.json 으로 저장합니다.
//
// 설계 27,714개에는 이름이 없어 목록에서 번호로만 구별됩니다. 원본 `design_tree.json`
// 에도 트리가 있지만 그건 제작 방식(어떤 부품을 어떤 슬롯에 끼웠나)의 트리라
// 생김새와 어긋납니다 — `ConnectedHub6_Sym` 과 `ConnectedHub6_2_2_2` 는 위에서 보면
// 프로펠러가 같은 자리에 있는데 다른 칸에 놓입니다. 그래서 보이는 것에서 다시 셉니다.
//
//   축1  프로펠러가 향하는 방향의 수  (15° 안의 프로펠러는 한 방향으로 묶음)
//   축2  기수·꼬리 쪽에 프로펠러가 있는지, 그 사이로 비켜 있는지
//   (축3 날개 유무는 design-index.json 의 numWings 로 이미 알 수 있어 넣지 않습니다)
//
// 배치 파일은 132MB라 목록 화면에서 받을 수 없으므로 설계당 숫자 하나로 줄입니다.
//
// 사용법:
//   node scripts/prepare-shape-classes.mjs
//
// 선행: prepare-part-placements.mjs 가 먼저 돌아 있어야 합니다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const dataDir = path.join(projectRoot, 'public', 'data');
const placementDir = path.join(dataDir, 'part-placements');
const catalogPath = path.join(dataDir, 'part-catalog.json');
const outputPath = path.join(dataDir, 'shape-classes.json');

const RADIANS = Math.PI / 180;
/** 이 각도 안에 있는 프로펠러는 같은 방향으로 본다. 한 팔에 둘 달린 경우가 18%다. */
const SAME_DIRECTION = 15;

function main() {
  for (const required of [placementDir, catalogPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(`${required} 가 없습니다. prepare-part-placements.mjs 를 먼저 실행하세요.`);
    }
  }
  const { types } = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const out = {};
  let designs = 0;
  let unclassified = 0;
  const tally = new Map();
  for (const file of fs.readdirSync(placementDir)) {
    if (!file.endsWith('.json')) continue;
    const group = JSON.parse(fs.readFileSync(path.join(placementDir, file), 'utf8'));
    for (const [id, design] of Object.entries(group)) {
      designs += 1;
      const angles = [];
      design.p.forEach((part, index) => {
        if (types[design.t?.[index]] !== 'Propeller') return;
        angles.push(((Math.atan2(part.p[1], part.p[0]) / RADIANS) + 360) % 360);
      });
      if (!angles.length) {
        unclassified += 1;
        continue;
      }
      const dirs = directionsOf(angles);
      const step = 360 / dirs.length;
      const phase = phaseOf(dirs);
      // 위상은 0° 아니면 간격의 절반, 두 값에만 몰린다(중간값은 1% 미만).
      const aligned = dirs.length < 2 || Math.min(phase, step - phase) < step / 4;
      // 방향 수와 정렬 여부를 숫자 하나로. 목록에서 받는 양을 줄인다.
      out[id] = dirs.length * 2 + (aligned ? 1 : 0);
      const key = `${dirs.length}${aligned ? '정렬' : '엇갈림'}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(out));
  const bytes = fs.statSync(outputPath).size;
  console.log(`Wrote ${designs.toLocaleString()} designs · ${(bytes / 1024).toFixed(0)} KB`);
  if (unclassified) console.log(`프로펠러가 없어 분류하지 못한 설계: ${unclassified.toLocaleString()}개`);
  const rows = [...tally].sort((a, b) => b[1] - a[1]);
  console.log('');
  for (const [key, count] of rows.slice(0, 12)) {
    console.log(`  ${key.padEnd(10)} ${String(count).padStart(6)}  ${(count / designs * 100).toFixed(1)}%`);
  }
}

/** 방위각을 15° 안에서 묶어 "프로펠러가 향하는 방향"들의 대표 각도를 만든다. */
function directionsOf(angles) {
  const sorted = [...angles].sort((a, b) => a - b);
  const groups = [];
  for (const angle of sorted) {
    const last = groups[groups.length - 1];
    if (last && angle - last[last.length - 1] <= SAME_DIRECTION) last.push(angle);
    else groups.push([angle]);
  }
  // 0° 근처와 360° 근처는 같은 방향이다.
  if (groups.length > 1) {
    const first = groups[0];
    const last = groups[groups.length - 1];
    if (first[0] + 360 - last[last.length - 1] <= SAME_DIRECTION) {
      groups[0] = [...last, ...first];
      groups.pop();
    }
  }
  return groups.map((group) => {
    let x = 0;
    let y = 0;
    for (const angle of group) {
      x += Math.cos(angle * RADIANS);
      y += Math.sin(angle * RADIANS);
    }
    return ((Math.atan2(y, x) / RADIANS) + 360) % 360;
  });
}

/**
 * 방향들이 기체 축에서 얼마나 돌아가 있는지.
 * 각도를 방향 수만큼 곱해 원 위에서 평균내야 한다. 그냥 나머지를 평균내면
 * 0°와 59°가 섞여 30°라는 없는 값이 나온다.
 */
function phaseOf(dirs) {
  const count = dirs.length;
  if (count < 2) return 0;
  let x = 0;
  let y = 0;
  for (const angle of dirs) {
    x += Math.cos(count * angle * RADIANS);
    y += Math.sin(count * angle * RADIANS);
  }
  return (((Math.atan2(y, x) / RADIANS) / count) + 360) % (360 / count);
}

main();
