import fs from 'node:fs';

// 설계 트리에서 팔 길이 파라미터를 접두사 포함 키로 모은다.
// (Arm_5 / RotatedArm_5 / FixedRotationArm_5 를 구분해야 한다)
const trees = new Map();
for (const f of fs.readdirSync('public/data/design-trees')) {
  const j = JSON.parse(fs.readFileSync('public/data/design-trees/' + f, 'utf8'));
  for (const [id, t] of Object.entries(j)) trees.set(id, t.sourceParameters);
}

const rows = [];
for (const f of fs.readdirSync('public/data/part-placements')) {
  const g = JSON.parse(fs.readFileSync('public/data/part-placements/' + f, 'utf8'));
  for (const [id, d] of Object.entries(g)) {
    const src = trees.get(id);
    if (!src) continue;

    const keys = new Map();
    for (const [name, value] of src) {
      const m = String(name).match(/^((?:Rotated|FixedRotation)?Arm)_(\d+)_Length$/i);
      if (m && typeof value === 'number') keys.set(m[1].toUpperCase() + '_' + m[2], value);
    }

    for (const p of d.p) {
      const m = p.n.match(/^(ROTATEDARM|FIXEDROTATIONARM|ARM)_(\d+)_/i);
      if (!m || !p.s || !(p.s[2] > 0)) continue;
      const param = keys.get(m[1].toUpperCase() + '_' + m[2]);
      if (param === undefined) continue;

      // 실측 s[2] 가 팔의 길이 방향이다. 5% 넘게 벌어지면 불일치로 본다.
      const err = Math.abs(param - p.s[2]) / p.s[2];
      if (err > 0.05) {
        rows.push({
          id: Number(id),
          part: p.n,
          real: Math.round(p.s[2]),
          param: Math.round(param),
          err: Number((err * 100).toFixed(0)),
        });
      }
    }
  }
}

rows.sort((a, b) => b.err - a.err);

const byDesign = new Map();
for (const r of rows) byDesign.set(r.id, (byDesign.get(r.id) ?? 0) + 1);

console.log(`불일치 팔 ${rows.length}개 · 설계 ${byDesign.size}개\n`);
console.log('설계별 개수');
for (const [id, n] of [...byDesign].sort((a, b) => b[1] - a[1])) {
  console.log(`  #${String(id).padEnd(7)} ${n}개`);
}

console.log('\n상위 25건');
for (const r of rows.slice(0, 25)) {
  console.log(
    `  #${String(r.id).padEnd(7)}${r.part.padEnd(26)}` +
    `실측 ${String(r.real).padStart(5)}  파라미터 ${String(r.param).padStart(5)}  오차 ${r.err}%`,
  );
}

fs.writeFileSync('arm-mismatch.json', JSON.stringify(rows, null, 1));
console.log(`\n전체 ${rows.length}건 → arm-mismatch.json`);
