import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';
import * as THREE from 'three';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function objectInfo(model, name) {
  const object = model.getObjectByName(name);
  assert.ok(object, `${name} should be rendered`);
  model.updateWorldMatrix(true, true);
  const position = object.getWorldPosition(object.position.clone());
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  const size = object.geometry.boundingBox.getSize(object.position.clone());
  const half = size.y / 2;
  const root = object.localToWorld(object.position.clone().set(0, -half, 0));
  const tip = object.localToWorld(object.position.clone().set(0, half, 0));
  return { position, size, endpoints: [root, tip] };
}

function positionOf(model, name) {
  const object = model.getObjectByName(name);
  assert.ok(object, `${name} should be rendered`);
  model.updateWorldMatrix(true, true);
  return object.getWorldPosition(object.position.clone());
}

function worldSizeOf(model, name) {
  const object = model.getObjectByName(name);
  assert.ok(object, `${name} should be rendered`);
  model.updateWorldMatrix(true, true);
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  const size = object.geometry.boundingBox.getSize(object.position.clone());
  const scale = object.getWorldScale(object.scale.clone());
  return size.multiply(scale);
}

function boundsSizeOf(model, name) {
  const object = model.getObjectByName(name);
  assert.ok(object, `${name} should be rendered`);
  model.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
}

function quaternionOf(model, name) {
  const object = model.getObjectByName(name);
  assert.ok(object, `${name} should be rendered`);
  model.updateWorldMatrix(true, true);
  return object.getWorldQuaternion(object.quaternion.clone());
}

function nearestEndpointDistance(left, right) {
  return Math.min(
    left[0].distanceTo(right[0]),
    left[0].distanceTo(right[1]),
    left[1].distanceTo(right[0]),
    left[1].distanceTo(right[1]),
  );
}

function assertFiniteModel(model, label) {
  model.updateWorldMatrix(true, true);
  model.traverse((object) => {
    assert.ok(
      object.matrixWorld.elements.every(Number.isFinite),
      `${label} ${object.name || object.type} should have a finite transform`,
    );
    if (!object.geometry) return;
    const positions = object.geometry.getAttribute('position');
    if (!positions) return;
    for (const value of positions.array) {
      assert.ok(Number.isFinite(value), `${label} ${object.name} should have finite geometry`);
    }
  });
}

function loadFixture(id, draftsModule, assemblyModule) {
  const shard = String(Math.floor(id / 1000)).padStart(3, '0');
  const group = String(Math.floor(id / 20)).padStart(4, '0');
  const source = readJson(`public/data/design-trees/shard-${shard}.json`)[String(id)];
  const placement = readJson(`public/data/part-placements/group-${group}.json`)[String(id)];
  const catalog = readJson('public/data/part-catalog.json');
  const baseline = draftsModule.hydrateDraft(source);
  const assembly = assemblyModule.resolveAssembly(placement, catalog);
  assert.ok(assembly, `design ${id} should have assembly data`);
  return { baseline, assembly };
}

function verifyRepresentativeArm({
  id,
  armName,
  viewer,
  draftsModule,
  assemblyModule,
}) {
  const { baseline, assembly } = loadFixture(id, draftsModule, assemblyModule);
  const target = viewer.resolveParametricEditTarget(armName, assembly, baseline, baseline, 'group');
  assert.notEqual(target.segmentIndex, null, `design ${id} ${armName} should bind to a segment`);
  assert.ok(target.armBaseLength && target.armBaseLength > 0);

  const originalModel = viewer.buildAircraftForAudit(baseline, assembly);
  const edited = draftsModule.cloneDraft(baseline);
  const segment = edited.segments[target.segmentIndex];
  segment.length *= 1.2;
  const editedModel = viewer.buildAircraftForAudit(edited, assembly, 2, baseline);
  const originalArm = objectInfo(originalModel, armName);
  const changedArm = objectInfo(editedModel, armName);
  assert.ok(changedArm.size.y > originalArm.size.y, `design ${id} ${armName} should grow`);
  assert.ok(
    nearestEndpointDistance(originalArm.endpoints, changedArm.endpoints) < 1e-6,
    `design ${id} ${armName} should preserve its inboard root`,
  );

  const movedDescendant = target.names
    .filter((name) => name !== armName && !/^ARM|^ROTATEDARM|^FIXEDROTATIONARM/i.test(name))
    .find((name) => {
      if (!originalModel.getObjectByName(name) || !editedModel.getObjectByName(name)) return false;
      return positionOf(originalModel, name).distanceTo(positionOf(editedModel, name)) > 0.01;
    });
  assert.ok(movedDescendant, `design ${id} should move at least one descendant of ${armName}`);

  const unrelatedArm = assembly.placements.find((part) =>
    /^(?:ARM|ROTATEDARM|FIXEDROTATIONARM)_/i.test(part.n) &&
    !target.names.includes(part.n),
  )?.n;
  if (unrelatedArm) {
    const before = objectInfo(originalModel, unrelatedArm);
    const after = objectInfo(editedModel, unrelatedArm);
    assert.ok(before.position.distanceTo(after.position) < 1e-9);
    assert.ok(Math.abs(before.size.y - after.size.y) < 1e-9);
  }

  const individual = draftsModule.cloneDraft(baseline);
  individual.instanceArmEdits = {
    [armName]: { length: target.armBaseLength * 1.2 },
  };
  const individualModel = viewer.buildAircraftForAudit(individual, assembly, 2, baseline);
  assert.ok(
    objectInfo(individualModel, armName).size.y > originalArm.size.y,
    `design ${id} should support an individual edit for ${armName}`,
  );
  const peerPrefix = armName.replace(/_\d+$/, '_');
  const symmetricPeer = assembly.placements.find(
    (part) => part.n !== armName && part.n.startsWith(peerPrefix),
  )?.n;
  if (symmetricPeer) {
    assert.ok(
      Math.abs(
        objectInfo(individualModel, symmetricPeer).size.y -
        objectInfo(originalModel, symmetricPeer).size.y,
      ) < 1e-9,
      `design ${id} individual edit should preserve ${symmetricPeer}`,
    );
  }

  const resetModel = viewer.buildAircraftForAudit(baseline, assembly);
  assert.ok(positionOf(originalModel, armName).distanceTo(positionOf(resetModel, armName)) < 1e-9);

  for (const length of [50, 520]) {
    const extreme = draftsModule.cloneDraft(baseline);
    extreme.segments[target.segmentIndex].length = length;
    const extremeModel = viewer.buildAircraftForAudit(extreme, assembly, 2, baseline);
    assertFiniteModel(extremeModel, `design ${id} length ${length}`);
    assert.ok(
      nearestEndpointDistance(
        originalArm.endpoints,
        objectInfo(extremeModel, armName).endpoints,
      ) < 1e-6,
      `design ${id} should preserve the root at ${length} mm`,
    );
  }
}

void test('representative arm structures preserve edit invariants', async (context) => {
  const server = await createServer({
    root: repoRoot,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  context.after(async () => server.close());

  const [viewer, draftsModule, assemblyModule] = await Promise.all([
    server.ssrLoadModule('/components/parametric-uav-viewer.tsx'),
    server.ssrLoadModule('/lib/design-draft.ts'),
    server.ssrLoadModule('/lib/assembly.ts'),
  ]);
  const source = readJson('public/data/design-trees/shard-009.json')['9961'];
  const placement = readJson('public/data/part-placements/group-0498.json')['9961'];
  const catalog = readJson('public/data/part-catalog.json');
  const baseline = draftsModule.hydrateDraft(source);
  const assembly = assemblyModule.resolveAssembly(placement, catalog);
  assert.ok(assembly);

  const target = viewer.resolveParametricEditTarget('ARM_4068_1', assembly, baseline, baseline);
  for (const instance of [1, 2, 3, 4]) {
    assert.ok(target.names.includes(`ARM_4068_${instance}`), 'all shared Arm_4068 instances should be highlighted');
  }
  assert.ok(target.names.includes('MOTOR_1') && target.names.includes('MOTOR_5'));
  assert.ok(!target.names.includes('ARM_4069_1'), 'a different arm parameter group should not be highlighted');
  const instanceTarget = viewer.resolveParametricEditTarget(
    'ARM_4068_1',
    assembly,
    baseline,
    baseline,
    'instance',
  );
  assert.ok(instanceTarget.names.includes('ARM_4068_1') && instanceTarget.names.includes('MOTOR_1'));
  assert.ok(!instanceTarget.names.includes('ARM_4068_2'), 'instance scope should highlight only one branch');

  const wingFixture = loadFixture(13077, draftsModule, assemblyModule);
  const wingArmTarget = viewer.resolveParametricEditTarget(
    'ARM_3610_1',
    wingFixture.assembly,
    wingFixture.baseline,
    wingFixture.baseline,
  );
  const wingTarget = viewer.resolveParametricEditTarget(
    'WING_472_1',
    wingFixture.assembly,
    wingFixture.baseline,
    wingFixture.baseline,
  );
  assert.deepEqual(
    [...new Set(wingTarget.names)].sort((left, right) => left.localeCompare(right)),
    [...new Set(wingArmTarget.names)].sort((left, right) => left.localeCompare(right)),
    'selecting a wing should highlight the same arm branches as selecting its parent arm group',
  );
  assert.equal(wingTarget.parameterGroup, 'wing', 'wing selection should still open wing controls');

  const pickedMotor = viewer.resolveParametricEditTarget('MOTOR_5', assembly, baseline, baseline);
  assert.equal(
    pickedMotor.propulsionIndex,
    baseline.propulsionGroups.findIndex((group) => group.motorInstance === 'Motor_5'),
    'a picked motor should open its own propulsion set instead of the first set on the segment',
  );

  const motorEdited = draftsModule.cloneDraft(baseline);
  const motorIndex = motorEdited.propulsionGroups.findIndex((group) => group.motorInstance === 'Motor_1');
  motorEdited.propulsionGroups[motorIndex].motorType = 'kde_direct_KDE600XF_530_G3';
  const motorEditedModel = viewer.buildAircraftForAudit(motorEdited, assembly, 2, baseline);
  const originalMotor1 = worldSizeOf(viewer.buildAircraftForAudit(baseline, assembly), 'MOTOR_1');
  const editedMotor1 = worldSizeOf(motorEditedModel, 'MOTOR_1');
  const originalMotor2 = worldSizeOf(viewer.buildAircraftForAudit(baseline, assembly), 'MOTOR_2');
  const editedMotor2 = worldSizeOf(motorEditedModel, 'MOTOR_2');
  assert.ok(
    editedMotor1.distanceTo(originalMotor1) > 0.01,
    'changing Motor_1 should change the Motor_1 preview size',
  );
  assert.ok(
    editedMotor2.distanceTo(originalMotor2) < 1e-9,
    'changing Motor_1 should not resize Motor_2',
  );

  const dualBattery = loadFixture(2, draftsModule, assemblyModule);
  const dualBatteryEdited = draftsModule.cloneDraft(dualBattery.baseline);
  dualBatteryEdited.energy.batteryTypes[1] = 'Tattu10C40000mAh6S1PHV';
  const originalBatteries = viewer.buildAircraftForAudit(
    dualBattery.baseline,
    dualBattery.assembly,
  );
  const editedBatteries = viewer.buildAircraftForAudit(
    dualBatteryEdited,
    dualBattery.assembly,
    2,
    dualBattery.baseline,
  );
  assert.ok(
    worldSizeOf(editedBatteries, 'BATTERY_2').distanceTo(
      worldSizeOf(originalBatteries, 'BATTERY_2'),
    ) > 0.01,
    'changing Battery_2 should change the Battery_2 preview size',
  );
  assert.ok(
    worldSizeOf(editedBatteries, 'BATTERY_1').distanceTo(
      worldSizeOf(originalBatteries, 'BATTERY_1'),
    ) < 1e-9,
    'changing Battery_2 should not resize Battery_1',
  );

  const friendlyEdited = draftsModule.cloneDraft(baseline);
  friendlyEdited.fuselage.length *= 1.15;
  friendlyEdited.fuselage.horizontalDiameter *= 1.1;
  friendlyEdited.fuselage.verticalDiameter *= 1.2;
  friendlyEdited.payload.mass = 5;
  friendlyEdited.wings[0].span *= 1.2;
  friendlyEdited.wings[0].chordInner *= 0.8;
  friendlyEdited.wings[0].chordOuter *= 1.3;
  friendlyEdited.wings[0].nacaProfile = '0006';
  const propellerIndex = friendlyEdited.propulsionGroups.findIndex(
    (group) => group.propellerInstance === 'Propeller_1',
  );
  friendlyEdited.propulsionGroups[propellerIndex].propellerType = 'apc_propellers_22x10E';
  const friendlyOriginalModel = viewer.buildAircraftForAudit(baseline, assembly);
  const friendlyEditedModel = viewer.buildAircraftForAudit(
    friendlyEdited,
    assembly,
    2,
    baseline,
  );
  for (const name of ['FUSELAGE_1', 'CARGO', 'WING_517_1', 'PROPELLER_1']) {
    assert.ok(
      boundsSizeOf(friendlyEditedModel, name).distanceTo(
        boundsSizeOf(friendlyOriginalModel, name),
      ) > 0.01,
      `${name} should visibly respond to its friendly parameter control`,
    );
  }
  assert.ok(
    boundsSizeOf(friendlyEditedModel, 'PROPELLER_2').distanceTo(
      boundsSizeOf(friendlyOriginalModel, 'PROPELLER_2'),
    ) < 1e-9,
    'changing Propeller_1 should not resize Propeller_2',
  );

  const bentGroupFromLower = viewer.resolveParametricEditTarget(
    'ARM_4071_1',
    assembly,
    baseline,
    baseline,
    'group',
  );
  assert.ok(
    bentGroupFromLower.names.includes('ROTATEDARM_1449_1') &&
      bentGroupFromLower.names.includes('ARM_4071_1') &&
      bentGroupFromLower.names.includes('ROTATEDARM_1449_2') &&
      bentGroupFromLower.names.includes('ARM_4071_2'),
    'either piece of a two-part segment should select the same complete symmetric group',
  );
  const bentInstanceFromLower = viewer.resolveParametricEditTarget(
    'ARM_4071_1',
    assembly,
    baseline,
    baseline,
    'instance',
  );
  assert.ok(!bentInstanceFromLower.names.includes('ROTATEDARM_1449_1'));

  const edited = draftsModule.cloneDraft(baseline);
  const segmentIndex = edited.segments.findIndex(
    (segment) => Math.abs(segment.length - 391.85718942146326) < 0.001,
  );
  assert.equal(segmentIndex, 2, 'fixture should map Arm_4068 to segment 3');
  edited.segments[segmentIndex].length = 520;

  const originalModel = viewer.buildAircraftForAudit(baseline, assembly);
  const editedModel = viewer.buildAircraftForAudit(edited, assembly, 2, baseline);
  const resetModel = viewer.buildAircraftForAudit(baseline, assembly);

  for (const instance of [1, 2, 3, 4]) {
    const name = `ARM_4068_${instance}`;
    const original = objectInfo(originalModel, name);
    const changed = objectInfo(editedModel, name);
    assert.ok(changed.size.y > original.size.y, `${name} should grow with its shared parameter`);
    assert.ok(
      nearestEndpointDistance(original.endpoints, changed.endpoints) < 1e-6,
      `${name} should keep its inboard root fixed`,
    );
  }

  const siblingBefore = objectInfo(originalModel, 'ARM_4069_1');
  const siblingAfter = objectInfo(editedModel, 'ARM_4069_1');
  assert.ok(
    siblingBefore.position.distanceTo(siblingAfter.position) < 1e-9 &&
      Math.abs(siblingBefore.size.y - siblingAfter.size.y) < 1e-9,
    'the sibling Arm_4069 group should not move or resize',
  );

  assert.ok(
    positionOf(originalModel, 'FLANGE_1').distanceTo(positionOf(editedModel, 'FLANGE_1')) > 1,
    'the selected arm descendant flange should follow the length edit',
  );
  assert.ok(
    positionOf(originalModel, 'FLANGE_3').distanceTo(positionOf(editedModel, 'FLANGE_3')) < 1e-9,
    'an unrelated sibling flange should remain fixed',
  );

  for (const name of ['ARM_4068_1', 'FLANGE_1', 'MOTOR_1', 'PROPELLER_1']) {
    assert.ok(
      positionOf(originalModel, name).distanceTo(positionOf(resetModel, name)) < 1e-9,
      `${name} should return exactly to baseline after reset`,
    );
  }

  const angled = draftsModule.cloneDraft(baseline);
  angled.segments[segmentIndex].angle = 30;
  const angledModel = viewer.buildAircraftForAudit(angled, assembly, 2, baseline);
  assert.ok(
    quaternionOf(originalModel, 'MOTOR_1').angleTo(quaternionOf(angledModel, 'MOTOR_1')) > 0.1,
    'a descendant motor orientation should follow the mounting-angle edit',
  );
  assert.ok(
    quaternionOf(originalModel, 'MOTOR_3').angleTo(quaternionOf(angledModel, 'MOTOR_3')) < 1e-7,
    'an unrelated sibling motor orientation should remain unchanged',
  );

  const offset = draftsModule.cloneDraft(baseline);
  offset.segments[segmentIndex].offset = 25;
  const offsetModel = viewer.buildAircraftForAudit(offset, assembly, 2, baseline);
  for (const name of ['FLANGE_1', 'MOTOR_1', 'PROPELLER_1']) {
    const distance = positionOf(originalModel, name).distanceTo(positionOf(offsetModel, name));
    assert.ok(Math.abs(distance - 0.25) < 1e-6, `${name} should follow the 25 mm offset`);
  }
  assert.ok(
    positionOf(originalModel, 'MOTOR_3').distanceTo(positionOf(offsetModel, 'MOTOR_3')) < 1e-9,
    'an unrelated sibling motor should ignore the offset edit',
  );

  const individual = draftsModule.cloneDraft(baseline);
  individual.instanceArmEdits = { ARM_4068_1: { length: 520 } };
  const individualModel = viewer.buildAircraftForAudit(individual, assembly, 2, baseline);
  assert.ok(
    objectInfo(individualModel, 'ARM_4068_1').size.y > objectInfo(originalModel, 'ARM_4068_1').size.y,
    'instance scope should grow the selected physical arm',
  );
  assert.ok(
    Math.abs(objectInfo(individualModel, 'ARM_4068_2').size.y - objectInfo(originalModel, 'ARM_4068_2').size.y) < 1e-9,
    'instance scope should preserve the symmetric peer arm',
  );
  assert.ok(
    positionOf(individualModel, 'FLANGE_1').distanceTo(positionOf(originalModel, 'FLANGE_1')) > 1,
    'the selected instance descendant should follow the edit',
  );
  assert.ok(
    positionOf(individualModel, 'FLANGE_2').distanceTo(positionOf(originalModel, 'FLANGE_2')) < 1e-9,
    'the symmetric peer descendant should remain fixed in instance scope',
  );

  const individualLower = draftsModule.cloneDraft(baseline);
  individualLower.instanceArmEdits = { ARM_4071_1: { length: 200 } };
  const individualLowerModel = viewer.buildAircraftForAudit(individualLower, assembly, 2, baseline);
  assert.ok(
    objectInfo(individualLowerModel, 'ARM_4071_1').size.y > objectInfo(originalModel, 'ARM_4071_1').size.y,
    'the lower physical piece of a bent segment should be directly editable',
  );
  for (const name of ['ROTATEDARM_1449_1', 'ARM_4071_2']) {
    assert.ok(
      Math.abs(objectInfo(individualLowerModel, name).size.y - objectInfo(originalModel, name).size.y) < 1e-9,
      `${name} should remain unchanged when only ARM_4071_1 is edited`,
    );
  }

  for (const fixture of [
    { id: 8, armName: 'ARM_60_1' },
    { id: 2, armName: 'ROTATEDARM_9_1' },
    { id: 1, armName: 'ARM_6_1' },
  ]) {
    verifyRepresentativeArm({
      ...fixture,
      viewer,
      draftsModule,
      assemblyModule,
    });
  }
});
