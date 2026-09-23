import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadTypeScript } from './helpers/load-typescript.mjs';

const { createBomSnapshot, draftFingerprint, parsePartSpecs } = await loadTypeScript('lib/parts/bom.ts');
const { calculateOfferAmounts } = await loadTypeScript('lib/parts/pricing.ts');
const { quoteToCsv } = await loadTypeScript('lib/parts/csv.ts');
const shard = JSON.parse(readFileSync(new URL('../public/data/design-trees/shard-000.json', import.meta.url), 'utf8'));
function draft() { return structuredClone(shard['2']); }
function item() { return { id: 'motor:test', kind: 'motor', model: 'Motor KV450', quantity: 5, instances: [], specs: { motorKv: 450 }, issues: [] }; }
function offer(changes = {}) {
  return {
    id: 'offer-1', productId: '1005001234', title: 'Motor KV450', url: 'https://www.aliexpress.com/item/1005001234.html',
    optionId: '450', optionLabel: 'KV450 / 2 pcs', optionVerified: true,
    packPrice: 12000, packQuantity: 2, currency: 'KRW', match: 'exact', reasons: [], specs: { motorKv: 450 },
    shippingAvailable: true, shippingCost: null, shippingCurrency: null, stock: 8, retrievedAt: '2026-09-13T00:00:00.000Z',
    ...changes,
  };
}

test('real design #2 retains five physical motors, five props, two same-model batteries and four servos', () => {
  const source = draft();
  const snapshot = createBomSnapshot(source);
  for (const [kind, count] of [['motor', 5], ['propeller', 5], ['battery', 2], ['servo', 4]]) {
    assert.equal(snapshot.items.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.quantity, 0), count);
  }
  assert.equal(snapshot.items.find((entry) => entry.kind === 'battery').quantity, 2);
  assert.equal(snapshot.items.find((entry) => entry.model === 't_motor_AT4130KV450').quantity, 4);
  assert.equal(source.physicalComponents.motors.length, 5);
});

test('edited motor, propeller and battery are overlaid by instance and index without changing source data', () => {
  const source = draft();
  const originalMotor = source.physicalComponents.motors[1].choice;
  source.propulsionGroups[1].motorType = 't_motor_AT4120KV560';
  source.propulsionGroups[1].propellerType = 'apc_propellers_13x4_5MR';
  source.energy.batteryTypes[1] = 'Tattu15C16000mAh4S1P';
  const snapshot = createBomSnapshot(source);
  assert.equal(snapshot.items.find((entry) => entry.model === originalMotor).quantity, 3);
  assert.deepEqual(snapshot.items.find((entry) => entry.model === 't_motor_AT4120KV560').instances, ['Motor_2']);
  assert.equal(snapshot.items.find((entry) => entry.model === 'apc_propellers_13x4_5MR').quantity, 1);
  assert.equal(snapshot.items.find((entry) => entry.model === 'Tattu15C16000mAh4S1P').quantity, 1);
  assert.equal(source.physicalComponents.motors[1].choice, originalMotor);
  source.propulsionGroups[1].motorType = 'later edit';
  assert.ok(snapshot.items.some((entry) => entry.model === 't_motor_AT4120KV560'));
});

test('physical wing linkage overlays an edited servo without duplicating physical cardinality', () => {
  const source = draft();
  source.wings[1].servoType = 'Hitec_HS_65MG';
  const servos = createBomSnapshot(source).items.filter((entry) => entry.kind === 'servo');
  assert.equal(servos.find((entry) => entry.model === 'Hitec_D485HW').quantity, 3);
  assert.deepEqual(servos.find((entry) => entry.model === 'Hitec_HS_65MG').instances, ['Servo_2']);
});

test('duplicate physical instance and repeated propulsion references are counted once', () => {
  const source = draft();
  source.physicalComponents.motors.push(structuredClone(source.physicalComponents.motors[0]));
  source.propulsionGroups.push(structuredClone(source.propulsionGroups[0]));
  assert.equal(createBomSnapshot(source).items.filter((entry) => entry.kind === 'motor').reduce((sum, entry) => sum + entry.quantity, 0), 5);
});

test('fallback templates never infer quantities from symmetry, array length or summary counts', () => {
  const source = draft();
  source.physicalComponents = { motors: [], propellers: [], batteries: [], wings: [], servos: [] };
  source.propulsionGroups = [{ ...source.propulsionGroups[0], motorInstance: undefined, propellerInstance: undefined }];
  source.wings = [];
  const snapshot = createBomSnapshot(source);
  assert.ok(snapshot.items.length >= 3);
  assert.ok(snapshot.items.every((entry) => entry.quantity === null));
  assert.ok(snapshot.items.every((entry) => entry.issues.length > 0));
});

test('ambiguous duplicate edits and missing models produce explicit issues', () => {
  const source = draft();
  source.propulsionGroups.push({ ...source.propulsionGroups[0], motorType: 'Other KV450' });
  source.energy.batteryTypes[0] = '';
  const snapshot = createBomSnapshot(source);
  assert.equal(snapshot.items.find((entry) => entry.instances.includes('Motor_1')).quantity, null);
  assert.ok(snapshot.items.find((entry) => entry.kind === 'battery' && !entry.model).issues.some((issue) => issue.includes('모델명')));
});

test('specs parse catalog decimal prop names and explicit battery values without rating guesses', () => {
  assert.deepEqual(parsePartSpecs('propeller', 'apc_propellers_9_625x3_75N'), { diameterIn: 9.625, pitchIn: 3.75 });
  assert.deepEqual(parsePartSpecs('motor', 't_motor_AT4120KV560'), { motorKv: 560 });
  assert.deepEqual(parsePartSpecs('motor', 'kde_direct_KDE600XF_530_G3'), {});
  assert.deepEqual(parsePartSpecs('battery', 'Tattu15C16000mAh4S1P'), { capacityMah: 16000, cells: 4, dischargeC: 15 });
  assert.deepEqual(parsePartSpecs('battery', 'TurnigyGraphene1600mAh4S75CSquare'), { capacityMah: 1600, cells: 4, dischargeC: 75 });
  assert.deepEqual(parsePartSpecs('servo', 'Hitec_HS_65MG'), {});
});

test('fingerprint is stable across key order and changes on any actual draft edit', () => {
  const source = draft();
  const reordered = Object.fromEntries(Object.entries(source).reverse());
  assert.equal(draftFingerprint(source), draftFingerprint(reordered));
  const snapshot = createBomSnapshot(source);
  source.payload.mass += 0.1;
  assert.notEqual(snapshot.fingerprint, draftFingerprint(source));
});

test('motor KV parsing separates suffix ratings, compact model numbers and SKU pack counts', () => {
  for (const [model, motorKv] of [
    ['980KV 4pcs', 980], ['980KV 4 pcs', 980], ['t_motor_MN4012KV400', 400], ['KV900 / 1pcs', 900],
    ['t_motor_U7_V2.0KV490', 490], ['980.5 KV / 2 pcs', 980.5], ['KV-980 / 4pcs', 980],
  ]) assert.deepEqual(parsePartSpecs('motor', model), { motorKv }, model);
  for (const model of [
    'kde_direct_KDE4012XF_400', '900KV / 1000KV', '900-1000KV', 'KV900-1000',
    '900, 1000KV', '900..1000KV', '1,000KV', 'KV1,000', 'KV980pcs',
  ]) assert.deepEqual(parsePartSpecs('motor', model), {}, model);
});

test('bundle arithmetic rounds up, keeps unknown shipping null and permits explicitly free shipping', () => {
  assert.deepEqual(calculateOfferAmounts(item(), offer()), { packCount: 3, unitPrice: 6000, subtotal: 36000, shipping: null });
  assert.equal(calculateOfferAmounts(item(), offer({ shippingCost: 0, shippingCurrency: 'KRW' })).shipping, 0);
  assert.equal(calculateOfferAmounts(item(), offer({ shippingCost: 5000, shippingCurrency: 'USD' })).shipping, null);
  assert.equal(calculateOfferAmounts(item(), offer({ shippingAvailable: null })).subtotal, 36000);
});

test('unverified or mismatched options, missing pack size, unavailable shipment and insufficient stock cannot produce confirmed totals', () => {
  for (const changes of [
    { optionVerified: false }, { specs: { motorKv: 500 } }, { packQuantity: null }, { packQuantity: 0 },
    { packQuantity: 1.5 }, { packPrice: NaN }, { packPrice: -1 }, { currency: 'USD' },
    { shippingAvailable: false }, { stock: 2 },
  ]) assert.equal(calculateOfferAmounts(item(), offer(changes)).subtotal, null);
  assert.equal(calculateOfferAmounts({ ...item(), quantity: null }, offer()).subtotal, null);
  assert.equal(calculateOfferAmounts({ ...item(), quantity: 1.5 }, offer()).subtotal, null);
  assert.equal(calculateOfferAmounts(item(), offer({ stock: null })).subtotal, 36000);
});

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if (character === '\r' && text[index + 1] === '\n' && !quoted) {
      row.push(field); rows.push(row); row = []; field = ''; index++;
    } else field += character;
  }
  return rows;
}

test('CSV matches pricing and snapshot, preserves URLs, quotes newlines and neutralizes spreadsheet formulas', () => {
  const selected = offer({ title: '=HYPERLINK("bad","click"),\nnext', optionLabel: ' +SUM(1,2)' });
  const snapshot = { fingerprint: 'abc', designId: 2, createdAt: selected.retrievedAt, items: [item()], exclusions: ['제작물 제외'] };
  const lines = [{ item: item(), selectedOfferId: selected.id, result: { status: 'ok', offers: [selected], warnings: [], retrievedAt: selected.retrievedAt } }];
  const csv = quoteToCsv(snapshot, lines);
  const rows = parseCsv(csv);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.length === 29));
  assert.equal(rows[1][9], `'${selected.title}`);
  assert.equal(rows[1][10], selected.url);
  assert.equal(rows[1][11], `'${selected.optionLabel}`);
  assert.equal(Number(rows[1][20]), calculateOfferAmounts(item(), selected).subtotal);
  assert.equal(rows[1][22], '미확인');
  assert.equal(rows[2][20], '36000');
  assert.equal(rows[2][22], '미확인');
  assert.match(rows[2][24], /최종 결제액 아님/);
});

test('CSV missing selected offer and all unknown prices keep totals unknown instead of zero', () => {
  const snapshot = { fingerprint: 'abc', designId: 2, createdAt: 'now', items: [item()], exclusions: [] };
  const rows = parseCsv(quoteToCsv(snapshot, []));
  assert.equal(rows[1][8], '미조회');
  assert.equal(rows[2][20], '미확인');
  assert.equal(rows[2][22], '미확인');
});
