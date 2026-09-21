'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

import { Button } from '@/components/ui/button';
import type {
  DesignDraft,
  DesignSegment,
  ParameterGroup,
  PartPlacement,
} from '@/lib/drawn-types';

export type ForceVectors = {
  drag?: number | null;
  lift?: number | null;
  thrust?: number | null;
};

export type ParametricHierarchyDiagnostics = {
  treePropellerAnchors: number;
  desiredPropellers: number;
  fallbackPropellers: number;
  surplusPropellers: number;
  treeWingAnchors: number;
  desiredWings: number;
  fallbackWings: number;
  surplusWings: number;
};

type ParametricUavViewerProps = {
  draft: DesignDraft;
  baseline?: DesignDraft | null;
  showGhost?: boolean;
  changedGroup?: ParameterGroup | null;
  pitchDegrees?: number;
  forceVectors?: ForceVectors;
  showForces?: boolean;
  syncGroup?: string;
  /** 원본 STEP 부품 배치. 주어지면 topology 추정 대신 이 좌표를 쓴다. */
  placements?: PartPlacement[] | null;
};

type ViewerRuntime = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  model: THREE.Group | null;
  ghost: THREE.Group | null;
  forces: THREE.Group | null;
  grid: THREE.GridHelper;
  fitCamera: (radius: number, force?: boolean) => void;
  radius: number;
  lastFittedRadius: number;
  topology: string;
  syncing: boolean;
};

const SCALE = 0.01;
const VIEWER_SYNC_GROUPS = new Map<string, Set<ViewerRuntime>>();

export function ParametricUavViewer({
  draft,
  baseline,
  showGhost = false,
  changedGroup = null,
  pitchDegrees = 0,
  forceVectors,
  showForces = false,
  syncGroup,
  placements = null,
}: ParametricUavViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const hierarchyDiagnostics = useMemo(
    () => analyzeParametricHierarchy(draft),
    [draft],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef3f6);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 1000);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch {
      window.setTimeout(() => {
        setStatus('error');
        setErrorMessage('이 브라우저에서 WebGL을 시작하지 못했습니다.');
      }, 0);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    Object.assign(renderer.domElement.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      touchAction: 'none',
    });
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      'aria-label',
      '파라메트릭 UAV 3D 미리보기. 방향키로 회전 및 확대/축소',
    );
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = true;
    controls.autoRotate = false;
    const handleKeyboard = (event: KeyboardEvent) => {
      const offset = camera.position.clone().sub(controls.target);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        offset.applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          event.key === 'ArrowLeft' ? 0.12 : -0.12,
        );
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        offset.multiplyScalar(event.key === 'ArrowUp' ? 0.9 : 1.1);
      } else {
        return;
      }
      event.preventDefault();
      camera.position.copy(controls.target).add(offset);
      controls.update();
    };
    renderer.domElement.addEventListener('keydown', handleKeyboard);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x91a9b6, 2.7));
    const key = new THREE.DirectionalLight(0xffffff, 3.3);
    key.position.set(8, 12, 7);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ee8ec, 1.8);
    fill.position.set(-7, 5, -8);
    scene.add(fill);

    const grid = new THREE.GridHelper(30, 30, 0x9cb3bd, 0xd4e0e5);
    const gridMaterials = Array.isArray(grid.material)
      ? grid.material
      : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.55;
    });
    grid.position.y = -0.9;
    scene.add(grid);

    let disposed = false;
    let frame = 0;
    let resizeFrame = 0;
    let lastWidth = 0;
    let lastHeight = 0;

    const fitCamera = (radius: number, force = false) => {
      const runtime = runtimeRef.current;
      if (!runtime || radius <= 0) return;
      const previous = runtime.lastFittedRadius;
      runtime.radius = radius;
      const changedMaterially =
        previous <= 0 || Math.abs(radius - previous) / previous > 0.22;
      if (!force && !changedMaterially) {
        controls.minDistance = Math.max(radius * 0.55, 1.5);
        controls.maxDistance = Math.max(radius * 8, 12);
        return;
      }
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov =
        2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), 0.1);
      const distance = (radius / Math.sin(limitingFov / 2)) * 1.12;
      camera.position.copy(
        new THREE.Vector3(1.12, 0.88, 1.2).normalize().multiplyScalar(distance),
      );
      camera.near = Math.max(radius / 100, 0.02);
      camera.far = Math.max(distance + radius * 10, 100);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0.35, 0);
      controls.minDistance = Math.max(radius * 0.55, 1.5);
      controls.maxDistance = Math.max(radius * 8, 12);
      controls.update();
      grid.scale.setScalar(Math.max(radius / 7, 0.65));
      runtime.lastFittedRadius = radius;
    };

    const runtime: ViewerRuntime = {
      scene,
      camera,
      renderer,
      controls,
      model: null,
      ghost: null,
      forces: null,
      grid,
      fitCamera,
      radius: 0,
      lastFittedRadius: 0,
      topology: '',
      syncing: false,
    };
    runtimeRef.current = runtime;
    if (syncGroup) {
      const members =
        VIEWER_SYNC_GROUPS.get(syncGroup) ?? new Set<ViewerRuntime>();
      members.add(runtime);
      VIEWER_SYNC_GROUPS.set(syncGroup, members);
    }
    const syncCamera = () => {
      if (!syncGroup || runtime.syncing) return;
      const members = VIEWER_SYNC_GROUPS.get(syncGroup);
      if (!members) return;
      for (const peer of members) {
        if (peer === runtime) continue;
        peer.syncing = true;
        peer.camera.position.copy(camera.position);
        peer.camera.quaternion.copy(camera.quaternion);
        peer.camera.zoom = camera.zoom;
        peer.camera.updateProjectionMatrix();
        peer.controls.target.copy(controls.target);
        peer.controls.update();
        peer.syncing = false;
      }
    };
    controls.addEventListener('change', syncCamera);

    const resize = () => {
      const width = Math.max(1, Math.floor(mount.clientWidth));
      const height = Math.max(1, Math.floor(mount.clientHeight));
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const runtime = runtimeRef.current;
      if (runtime?.radius) runtime.fitCamera(runtime.radius, true);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(mount);
    resize();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) {
        setStatus('error');
        setErrorMessage('3D 그래픽 연결이 중단되었습니다. 다시 시도해 주세요.');
      }
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener(
        'webglcontextlost',
        handleContextLost,
      );
      renderer.domElement.removeEventListener('keydown', handleKeyboard);
      controls.dispose();
      controls.removeEventListener('change', syncCamera);
      if (syncGroup) {
        const members = VIEWER_SYNC_GROUPS.get(syncGroup);
        members?.delete(runtime);
        if (!members?.size) VIEWER_SYNC_GROUPS.delete(syncGroup);
      }
      disposeObject(runtimeRef.current?.model);
      disposeObject(runtimeRef.current?.ghost);
      disposeObject(runtimeRef.current?.forces);
      grid.geometry.dispose();
      gridMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, [retryKey, syncGroup]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const topologyChanged = runtime.topology !== draft.topology;
      runtime.topology = draft.topology;
      if (runtime.model) {
        runtime.scene.remove(runtime.model);
        disposeObject(runtime.model);
      }
      if (runtime.ghost) {
        runtime.scene.remove(runtime.ghost);
        disposeObject(runtime.ghost);
      }
      if (runtime.forces) {
        runtime.scene.remove(runtime.forces);
        disposeObject(runtime.forces);
      }

      runtime.model = buildAircraft(draft, changedGroup, false, placements, baseline);
      runtime.model.rotation.z = THREE.MathUtils.degToRad(pitchDegrees);
      runtime.scene.add(runtime.model);

      if (showGhost && baseline) {
        runtime.ghost = buildAircraft(baseline, null, true, placements);
        runtime.ghost.rotation.z = THREE.MathUtils.degToRad(pitchDegrees);
        runtime.scene.add(runtime.ghost);
      } else {
        runtime.ghost = null;
      }

      runtime.forces = showForces ? buildForceVectors(forceVectors) : null;
      if (runtime.forces) runtime.scene.add(runtime.forces);

      const box = new THREE.Box3().setFromObject(runtime.model);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      runtime.fitCamera(
        Math.max(sphere.radius, 2.5),
        topologyChanged || runtime.radius === 0,
      );
      window.queueMicrotask(() => {
        setStatus('ready');
        setErrorMessage('');
      });
    } catch {
      window.queueMicrotask(() => {
        setStatus('error');
        setErrorMessage('파라메트릭 형상을 생성하지 못했습니다.');
      });
    }
  }, [
    baseline,
    changedGroup,
    draft,
    forceVectors,
    pitchDegrees,
    placements,
    showForces,
    showGhost,
    retryKey,
  ]);

  return (
    <div
      ref={mountRef}
      data-viewer-status={status}
      data-draft-id={draft.baselineId}
      data-arm-lengths={draft.segments
        .map((segment) => segment.length.toFixed(2))
        .join(',')}
      data-segment-angles={draft.segments
        .map((segment) => segment.angle.toFixed(2))
        .join(',')}
      data-fuselage-size={[
        draft.fuselage.length,
        draft.fuselage.horizontalDiameter,
        draft.fuselage.verticalDiameter,
      ]
        .map((value) => value.toFixed(2))
        .join(',')}
      data-wing-spans={draft.wings
        .map((wing) => wing.span.toFixed(2))
        .join(',')}
      data-rendered-propellers={hierarchyDiagnostics.desiredPropellers}
      data-tree-propeller-anchors={hierarchyDiagnostics.treePropellerAnchors}
      data-radial-fallback-propellers={hierarchyDiagnostics.fallbackPropellers}
      data-surplus-propeller-anchors={hierarchyDiagnostics.surplusPropellers}
      data-rendered-wings={hierarchyDiagnostics.desiredWings}
      data-tree-wing-anchors={hierarchyDiagnostics.treeWingAnchors}
      data-radial-fallback-wings={hierarchyDiagnostics.fallbackWings}
      data-surplus-wing-anchors={hierarchyDiagnostics.surplusWings}
      className="absolute inset-0 overflow-hidden bg-[#f5f5f7] outline-none [&>canvas:focus-visible]:ring-2 [&>canvas:focus-visible]:ring-inset [&>canvas:focus-visible]:ring-[#3182f6]"
    >
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 grid place-items-center text-xs font-semibold tracking-[0.12em] text-[#6e6e73]">
          파라메트릭 형상 준비 중
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/90 p-6 text-center backdrop-blur-sm">
          <div>
            <p className="text-sm font-medium text-amber-800">{errorMessage}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStatus('loading');
                setRetryKey((value) => value + 1);
              }}
              className="mt-4 border-amber-200 bg-white text-amber-900"
            >
              <RefreshCw /> 다시 시도
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const COLORS = {
  structure: 0x167f91,
  fuselage: 0xe7eef1,
  propulsion: 0x233a49,
  energy: 0x6d5bd0,
  wing: 0x82c4ce,
  payload: 0xe7a33e,
  layout: 0x1c9b62,
} as const;

type MaterialFactory = (
  kind: keyof typeof COLORS,
  metalness?: number,
) => THREE.MeshStandardMaterial;

function createMaterialFactory(
  changedGroup: ParameterGroup | null,
  ghost: boolean,
): MaterialFactory {
  return (kind, metalness = 0.12) => {
    const active = changedGroup === kind;
    return new THREE.MeshStandardMaterial({
      color: ghost ? 0x7f96a2 : COLORS[kind],
      roughness: ghost ? 0.8 : 0.48,
      metalness: ghost ? 0 : metalness,
      transparent: ghost,
      opacity: ghost ? 0.16 : 1,
      depthWrite: !ghost,
      emissive: !ghost && active ? COLORS[kind] : 0x000000,
      emissiveIntensity: !ghost && active ? 0.28 : 0,
      side: THREE.DoubleSide,
    });
  };
}

function buildAircraft(
  draft: DesignDraft,
  changedGroup: ParameterGroup | null,
  ghost: boolean,
  placements: PartPlacement[] | null = null,
  baseline: DesignDraft | null = null,
) {
  if (placements?.length) {
    return buildFromPlacements(draft, placements, changedGroup, ghost, baseline);
  }

  const group = new THREE.Group();
  group.name = ghost ? 'baseline-ghost' : 'editable-aircraft';

  const colors = COLORS;
  const material = createMaterialFactory(changedGroup, ghost);

  const fuselage = draft.fuselage;
  // The source geometry is a flat rounded box, not an ellipsoid. A sphere scaled
  // to the same numbers reads as an egg and hides the wide, low proportion.
  const bodyWidth = Math.max(fuselage.length * SCALE, 1.3);
  const bodyHeight = Math.max(fuselage.verticalDiameter * SCALE, 0.68);
  const bodyDepth = Math.max(fuselage.horizontalDiameter * SCALE, 1.56);
  const body = new THREE.Mesh(
    new RoundedBoxGeometry(
      bodyWidth,
      bodyHeight,
      bodyDepth,
      4,
      Math.min(bodyWidth, bodyHeight, bodyDepth) * 0.24,
    ),
    material('fuselage', 0.22),
  );
  body.name = 'fuselage';
  // Source STLs stack the craft as landing gear → rotors → arm deck → fuselage,
  // with the fuselage floor meeting the arms exactly. Fixed constants used to
  // flatten all of that into one plane regardless of the body's real height.
  const deckY = Math.max(bodyHeight * 0.7, fuselage.floorHeight * SCALE * 3, 0.5);
  const bodyCenterY = deckY + bodyHeight * 0.5;
  body.position.y = bodyCenterY;
  group.add(body);

  const topologyCount = Math.max(
    2,
    Math.min(
      14,
      Number(
        draft.topology.match(/Hub(\d+)/)?.[1] ??
          draft.numPropellers ??
          draft.propulsionGroups.length ??
          4,
      ),
    ),
  );
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(
      0.42 + topologyCount * 0.025,
      0.48 + topologyCount * 0.025,
      0.28,
      Math.max(topologyCount * 2, 12),
    ),
    material('structure', 0.34),
  );
  hub.position.y = deckY;
  group.add(hub);

  const usableSegments = draft.segments.filter((segment) => segment.length > 0);
  const propSegments = usableSegments.filter(
    (segment) =>
      segment.motorType ||
      segment.propellerType ||
      /Prop/i.test(segment.nodeType),
  );
  const fallbackLength =
    usableSegments.reduce((sum, item) => sum + item.length, 0) /
      Math.max(usableSegments.length, 1) || 330;
  const propulsion = draft.propulsionGroups.length
    ? draft.propulsionGroups
    : propSegments.map((segment, index) => ({
        id: `fallback-${index}`,
        path: segment.path,
        segmentId: segment.id,
        motorType: segment.motorType ?? '',
        propellerType: segment.propellerType ?? '',
      }));

  const armResult = buildHierarchicalArms(
    draft,
    fallbackLength,
    deckY,
    (start, end, nodeType) => {
      const radius = /MountBracket/i.test(nodeType)
        ? 0.035
        : /Wing/i.test(nodeType)
          ? 0.055
          : /Branch|Cross/i.test(nodeType)
            ? 0.09
            : 0.075;
      group.add(
        cylinderBetween(start, end, radius, material('structure', 0.4)),
      );
    },
  );
  const desiredPropellerCount = Math.max(
    draft.numPropellers || propulsion.length || topologyCount,
    1,
  );
  const propellerAnchors = armResult.propellerAnchors.slice(
    0,
    desiredPropellerCount,
  );
  while (propellerAnchors.length < desiredPropellerCount) {
    const index = propellerAnchors.length;
    const angle = (index / desiredPropellerCount) * Math.PI * 2;
    const length = Math.max(fallbackLength * SCALE, 1.45);
    const start = new THREE.Vector3(
      Math.cos(angle) * 0.25,
      deckY,
      Math.sin(angle) * 0.25,
    );
    const end = new THREE.Vector3(
      Math.cos(angle) * length,
      deckY,
      Math.sin(angle) * length,
    );
    group.add(cylinderBetween(start, end, 0.075, material('structure', 0.4)));
    propellerAnchors.push({ point: end, angle });
  }

  propellerAnchors.forEach(({ point: end, angle: baseAngle }, index) => {
    const propulsionGroup = propulsion[index % Math.max(propulsion.length, 1)];
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(
        motorRadius(propulsionGroup?.motorType),
        motorRadius(propulsionGroup?.motorType) * 0.93,
        0.28,
        24,
      ),
      material('propulsion', 0.55),
    );
    // Motors hang below the arm end and the rotor disc sits under them, matching
    // the source silhouette where the widest band is below the arm deck.
    motor.position.copy(end).add(new THREE.Vector3(0, -0.14, 0));
    motor.name = `motor-${index + 1}`;
    group.add(motor);

    const { diameter, pitch } = propellerSize(propulsionGroup?.propellerType);
    const rotor = new THREE.Group();
    rotor.name = `propeller-${index + 1}`;
    rotor.position.copy(end).add(new THREE.Vector3(0, -0.3, 0));
    const rotorRadius = diameter * 25.4 * SCALE * 0.5;
    // Blades alone read as thin sticks. The swept disc restores the silhouette
    // the source STL shows, where rotor discs dominate the top view.
    const sweep = new THREE.Mesh(
      new THREE.CylinderGeometry(rotorRadius, rotorRadius, 0.015, 44),
      new THREE.MeshStandardMaterial({
        color: ghost ? 0x7f96a2 : colors.propulsion,
        transparent: true,
        opacity: ghost ? 0.05 : 0.16,
        depthWrite: false,
        roughness: 0.65,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    sweep.name = `propeller-sweep-${index + 1}`;
    rotor.add(sweep);
    const hubCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.11, 0.1, 18),
      material('propulsion', 0.3),
    );
    rotor.add(hubCap);
    for (let bladeIndex = 0; bladeIndex < 2; bladeIndex += 1) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(
          rotorRadius * 0.92,
          0.035 + pitch * 0.0015,
          Math.max(0.085, rotorRadius * 0.085),
        ),
        material('propulsion', 0.18),
      );
      blade.position.x =
        bladeIndex === 0 ? rotorRadius * 0.48 : -rotorRadius * 0.48;
      blade.rotation.y = bladeIndex === 0 ? 0.07 : -0.07;
      rotor.add(blade);
    }
    rotor.rotation.y = baseAngle * 0.5;
    group.add(rotor);
  });

  const batteryTypes = draft.energy.batteryTypes.length
    ? draft.energy.batteryTypes
    : [''];
  batteryTypes.forEach((batteryType, index) => {
    const batteryCapacity = batteryInfo(batteryType);
    const batteryScale = THREE.MathUtils.clamp(
      Math.cbrt(batteryCapacity.capacity / 5000),
      0.7,
      1.7,
    );
    const battery = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.9 * batteryScale,
        0.32 * batteryScale,
        0.5 * batteryScale,
      ),
      material('energy', 0.05),
    );
    battery.name = `battery-envelope-${index + 1}`;
    // Batteries ride inside the fuselage, so they follow its centre height.
    battery.position.set(
      (index - (batteryTypes.length - 1) / 2) * 0.65,
      bodyCenterY,
      0,
    );
    group.add(battery);
  });

  if (draft.payload.mass > 0) {
    const payloadHeight = 0.28 + Math.min(draft.payload.mass, 10) * 0.025;
    const payload = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, payloadHeight, 0.4),
      material('payload', 0.08),
    );
    payload.name = 'payload';
    // Cargo hangs under the fuselage floor rather than at a fixed depth.
    payload.position.set(
      0,
      bodyCenterY - bodyHeight * 0.5 - payloadHeight * 0.5,
      0,
    );
    group.add(payload);
  }

  const desiredWingCount = Math.max(draft.numWings || draft.wings.length, 0);
  const wingAnchors = armResult.wingAnchors.slice(0, desiredWingCount);
  while (wingAnchors.length < desiredWingCount) {
    const index = wingAnchors.length;
    const angle = (index / Math.max(desiredWingCount, 1)) * Math.PI * 2;
    wingAnchors.push({
      point: new THREE.Vector3(
        Math.cos(angle) * Math.max(armResult.maxReach * 0.38, 0.7),
        0.7,
        Math.sin(angle) * Math.max(armResult.maxReach * 0.38, 0.7),
      ),
      angle,
    });
  }
  wingAnchors.forEach(({ point, angle }, wingIndex) => {
    const wing = draft.wings[wingIndex % Math.max(draft.wings.length, 1)];
    if (!wing) return;
    const span = Math.max(
      Math.min(wing.span * SCALE * 0.5, Math.max(armResult.maxReach * 0.65, 2)),
      1.1,
    );
    const root = Math.max(wing.chordInner * SCALE, 0.5);
    const tip = Math.max(wing.chordOuter * SCALE, 0.3);
    const shape = new THREE.BufferGeometry();
    const taper = wing.taperOffset ? (root - tip) * 0.45 : 0;
    const vertices = new Float32Array([
      0,
      0,
      -root * 0.5,
      0,
      0,
      root * 0.5,
      span,
      0,
      tip * 0.5 + taper,
      span,
      0,
      -tip * 0.5 + taper,
    ]);
    shape.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    shape.setIndex([0, 1, 2, 0, 2, 3]);
    shape.computeVertexNormals();
    const mesh = new THREE.Mesh(shape, material('wing', 0.18));
    mesh.name = `wing-${wingIndex + 1}`;
    mesh.position
      .copy(point)
      .add(new THREE.Vector3(0, (wingIndex % 2) * 0.035, 0));
    mesh.rotation.y = -angle + THREE.MathUtils.degToRad(wing.rotation || 0);
    mesh.rotation.z = THREE.MathUtils.degToRad((wing.rotation || 0) * 0.08);
    group.add(mesh);
  });

  Object.entries(draft.layout)
    .slice(0, 8)
    .forEach(([name, position]) => {
      const sensor = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 10, 8),
        material('layout', 0.1),
      );
      sensor.name = `sensor-${name}`;
      sensor.position.set(
        position.x * SCALE,
        bodyCenterY + bodyHeight * 0.5,
        position.y * SCALE,
      );
      group.add(sensor);
    });

  return group;
}

/**
 * 원본 STEP 좌표로 기체를 조립한다. 부품 이름과 위치·방향이 모두 주어지므로
 * topology 문자열로 배치를 추정하던 경로(buildAircraft의 나머지)를 대신한다.
 * STEP은 Z가 높이인 mm 좌표계라 Three.js 축(Y가 높이)으로 바꿔 넣는다.
 */
function buildFromPlacements(
  draft: DesignDraft,
  placements: PartPlacement[],
  changedGroup: ParameterGroup | null,
  ghost: boolean,
  baseline: DesignDraft | null = null,
) {
  const group = new THREE.Group();
  group.name = ghost ? 'baseline-ghost' : 'editable-aircraft';
  const makeMaterial = createMaterialFactory(changedGroup, ghost);
  // A design carries up to 126 parts. Building one material per part pushed
  // hundreds of shader programs at the GPU and made the viewer sluggish.
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const material: MaterialFactory = (kind, metalness = 0.12) => {
    const key = `${kind}:${metalness}`;
    const cached = materialCache.get(key);
    if (cached) return cached;
    const created = makeMaterial(kind, metalness);
    materialCache.set(key, created);
    return created;
  };

  const toScene = (v: readonly number[]) =>
    new THREE.Vector3(v[0] * SCALE, v[2] * SCALE, -v[1] * SCALE);
  const toDirection = (v: readonly number[]) =>
    new THREE.Vector3(v[0], v[2], -v[1]).normalize();

  // `ARM_55703_1`의 55703은 sourceParameters의 `Arm_55703_Length`와 같은 키다.
  // 길이는 draft에서 읽으므로 슬라이더 편집이 그대로 반영된다.
  const lengthByKey = new Map<string, number>();
  for (const [name, value] of draft.sourceParameters) {
    const key = name.match(/^(?:Rotated|FixedRotation)?Arm_(\d+)_Length$/i)?.[1];
    if (key && typeof value === 'number') lengthByKey.set(key, value);
  }
  const fallbackArmLength =
    draft.segments.reduce((sum, segment) => sum + segment.length, 0) /
      Math.max(draft.segments.length, 1) || 300;

  const orient = (mesh: THREE.Object3D, axis: THREE.Vector3) => {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  };

  const propeller = propellerSize(draft.propulsionGroups[0]?.propellerType);
  const catalogRotorRadius = (propeller.diameter * 25.4 * SCALE) / 2;
  const catalogMotorRadius = motorRadius(draft.propulsionGroups[0]?.motorType);
  const wingGeometry = draft.wings[0];
  // 실측 치수가 있으면 그것을 쓴다. 같은 설계 안에서도 프로펠러 지름이
  // 부품마다 다르므로 카탈로그 문자열 하나로는 맞출 수 없다.
  const measured = (part: PartPlacement) =>
    part.s ? (part.s.map((v) => v * SCALE) as [number, number, number]) : null;
  const largestOf = (size: [number, number, number] | null) =>
    size ? Math.max(...size) : null;

  /**
   * 부품이 기록한 로컬 축 세 개를 장면 좌표로 돌려준다. STEP은 X축과 Z축만
   * 적으므로 Y축은 외적으로 복원한다. 실측 치수 `s`는 이 순서와 같은 축에
   * 대응하므로, 축 하나를 고르면 그 방향의 길이도 함께 알 수 있다.
   */
  const basisOf = (part: PartPlacement) => {
    const x = toDirection(part.x);
    const z = toDirection(part.z);
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    return [x, y, z] as const;
  };

  /**
   * 실측 치수를 쓰면 형상은 정확해지지만 슬라이더를 움직여도 상자가 그대로라
   * 편집 피드백이 사라진다. 기준 설계 대비 변화율을 곱해 둘 다 잡는다.
   * 편집 전에는 비율이 정확히 1이므로 실측 그대로 그려진다.
   */
  const reference = baseline ?? draft;
  const growth = (current: number, original: number) =>
    original > 0 && current > 0
      ? THREE.MathUtils.clamp(Math.cbrt(current / original), 0.4, 2.5)
      : 1;

  /** 부품의 로컬 축을 그대로 회전으로 옮긴다. 세 축이 직교하므로 항상 정회전이다. */
  const orientToBasis = (mesh: THREE.Object3D, part: PartPlacement) => {
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(...basisOf(part)),
    );
  };

  /**
   * 원통 부품이 누운 축. 나머지 두 변이 가장 비슷해지는 축이 지름 한 쌍을
   * 이루므로, 그 축이 원통의 길이 방향이다. 모터는 이 축이 X 26%·Y 19%·Z 55%로
   * 갈리는데, 예전처럼 Z로 고정하면 45%가 지름과 길이를 맞바꿔 그렸다.
   */
  const cylinderAxisOf = (size: readonly number[]) => {
    let best = 2;
    let spread = Infinity;
    for (let index = 0; index < 3; index += 1) {
      const [a, b] = [0, 1, 2]
        .filter((other) => other !== index)
        .map((other) => size[other]);
      const gap = Math.abs(a - b) / Math.max(a, b, 1e-6);
      if (gap < spread) {
        spread = gap;
        best = index;
      }
    }
    return best;
  };

  /** 실측 치수가 목표 길이에 가장 가까운 축의 번호. */
  const axisNearest = (
    size: readonly number[] | undefined,
    target: number,
    candidates: readonly number[],
  ) => {
    if (!size) return candidates[0];
    let best = candidates[0];
    let error = Infinity;
    for (const index of candidates) {
      const gap = Math.abs(size[index] - target);
      if (gap < error) {
        error = gap;
        best = index;
      }
    }
    return best;
  };

  // 부품 이름은 `WING_<그룹>_<인스턴스>` 꼴인데, 같은 그룹의 인스턴스는 치수가
  // 같고 파라미터의 끝번호는 그룹 번호가 아니라 그 순서에 대응한다. 이름을
  // 파라미터 경로에 그대로 맞추면 실측과 74%만 일치하지만, 이 규칙은 91.9%로
  // 데이터가 허용하는 상한(92.5%)에 사실상 닿는다.
  const wingGroups = [
    ...new Set(
      placements
        .map((part) => Number(part.n.match(/^WING_(\d+)_/i)?.[1]))
        .filter((value) => Number.isFinite(value)),
    ),
  ].sort((a, b) => a - b);
  const wingParametersFor = (partName: string) => {
    const rank = wingGroups.indexOf(Number(partName.match(/^WING_(\d+)_/i)?.[1])) + 1;
    if (rank < 1) return wingGeometry;
    return (
      draft.wings.find((wing) => wing.path.endsWith(`_${rank}`)) ??
      draft.wings[rank - 1] ??
      wingGeometry
    );
  };

  for (const part of placements) {
    const name = part.n.toUpperCase();
    if (name === 'UAV_ASM' || name === 'ORIENT') continue;
    const position = toScene(part.p);
    const axis = toDirection(part.z);

    if (name.startsWith('MOTOR')) {
      const size = measured(part);
      // 축이 항상 로컬 Z라고 보던 탓에, 캔처럼 길쭉한 모터가 납작한 원반이
      // 되어 암 끝과 프로펠러 사이가 비어 보였다. 실측 세 변에서 지름 한
      // 쌍을 찾아 나머지를 길이로 쓴다.
      const axisIndex = size ? cylinderAxisOf(size) : 2;
      const girth = size
        ? [0, 1, 2].filter((index) => index !== axisIndex).map((index) => size[index])
        : null;
      // 모터 종류를 바꾸면 카탈로그 반지름이 달라진다. 그 변화율만 실측에
      // 곱해, 편집 전에는 실측 그대로이면서 편집은 형상에 보이게 한다.
      const edit = growth(
        motorRadius(draft.propulsionGroups[0]?.motorType),
        motorRadius(reference.propulsionGroups[0]?.motorType),
      );
      const radius = (girth ? (girth[0] + girth[1]) / 4 : catalogMotorRadius) * edit;
      const height = (size ? Math.max(size[axisIndex], 0.02) : 0.28) * edit;
      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius * 0.93, height, 24),
        material('propulsion', 0.55),
      );
      motor.position.copy(position);
      // 모터의 64%는 90° 단위가 아닌 각도로 달려 있다. 회전을 빼면 암이 꺾인
      // 설계에서 모터만 수직으로 남는다.
      if (size) orient(motor, basisOf(part)[axisIndex]);
      motor.name = part.n;
      group.add(motor);
      continue;
    }

    if (name.startsWith('PROPELLER')) {
      const size = measured(part);
      // 프로펠러는 회전면이 납작한 원판이라 가장 긴 변이 지름이다.
      const edit = growth(
        propellerSize(draft.propulsionGroups[0]?.propellerType).diameter,
        propellerSize(reference.propulsionGroups[0]?.propellerType).diameter,
      );
      const rotorRadius = ((largestOf(size) ?? catalogRotorRadius * 2) / 2) * edit;
      const rotor = new THREE.Group();
      rotor.name = part.n;
      rotor.position.copy(position);
      orient(rotor, axis);
      rotor.add(
        new THREE.Mesh(
          new THREE.CylinderGeometry(rotorRadius, rotorRadius, 0.015, 44),
          new THREE.MeshStandardMaterial({
            color: ghost ? 0x7f96a2 : COLORS.propulsion,
            transparent: true,
            opacity: ghost ? 0.05 : 0.16,
            depthWrite: false,
            roughness: 0.65,
            metalness: 0,
            side: THREE.DoubleSide,
          }),
        ),
      );
      for (let blade = 0; blade < 2; blade += 1) {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(
            rotorRadius * 1.84,
            0.035 + propeller.pitch * 0.0015,
            Math.max(0.085, rotorRadius * 0.17),
          ),
          material('propulsion', 0.18),
        );
        mesh.rotation.y = blade === 0 ? 0.07 : Math.PI / 2 - 0.07;
        rotor.add(mesh);
      }
      group.add(rotor);
      continue;
    }

    if (/^(?:ROTATEDARM|FIXEDROTATIONARM|ARM)_/.test(name)) {
      const key = part.n.match(/_(\d+)_/)?.[1] ?? '';
      const length = (lengthByKey.get(key) ?? fallbackArmLength) * SCALE;
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, Math.max(length, 0.2), 0.05),
        material('structure', 0.4),
      );
      bar.position.copy(position);
      orient(bar, axis);
      bar.name = part.n;
      group.add(bar);
      continue;
    }

    if (/^(?:BEND|BRANCH|CROSS|FLANGE)/.test(name)) {
      // 관절을 13mm 정육면체로 고정해 두었는데 실제 중앙값은 49mm다. 3.8배
      // 작은 탓에 팔과 모터 사이를 이어주지 못하고 눈에 띄는 틈이 생겼다.
      const size = measured(part);
      const joint = new THREE.Mesh(
        size
          ? new THREE.BoxGeometry(size[0], size[1], size[2])
          : new THREE.BoxGeometry(0.13, 0.13, 0.13),
        material('structure', 0.34),
      );
      joint.position.copy(position);
      if (size) orientToBasis(joint, part);
      joint.name = part.n;
      group.add(joint);
      continue;
    }

    if (name.startsWith('MAINHUB')) {
      // 허브 93.6%는 지름 66 · 높이 20인 납작한 원반인데 높이 24로 고정해 두어
      // 실제보다 두꺼웠다. 나머지 6.4%는 원반이 아니라 66mm 길이의 막대라
      // 크기뿐 아니라 축도 실측에서 읽어야 한다.
      const size = measured(part);
      const axisIndex = size ? cylinderAxisOf(size) : 1;
      const girth = size
        ? [0, 1, 2].filter((index) => index !== axisIndex).map((index) => size[index])
        : null;
      const radius = girth ? (girth[0] + girth[1]) / 4 : 0.32;
      const height = size ? Math.max(size[axisIndex], 0.02) : 0.24;
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, height, 18),
        material('structure', 0.34),
      );
      hub.position.copy(position);
      if (size) orient(hub, basisOf(part)[axisIndex]);
      hub.name = part.n;
      group.add(hub);
      continue;
    }

    if (name.startsWith('FUSELAGE')) {
      // 동체는 아래가 좁고 가운데가 부푼 곡면 선체다. STEP 꼭짓점만으로 재면
      // 폭·깊이는 27,713개 전부 정확한데 높이만 예외 없이 실제의 0.47배로
      // 나와, 두꺼운 선체가 납작한 판이 되고 안에 들어가야 할 배터리가
      // 밖으로 비어져 나왔다. 셋 다 파라미터에서 읽는다.
      const width = Math.max(draft.fuselage.length * SCALE, 0.05);
      const height = Math.max(draft.fuselage.verticalDiameter * SCALE, 0.05);
      const depth = Math.max(draft.fuselage.horizontalDiameter * SCALE, 0.05);
      const body = new THREE.Mesh(
        new RoundedBoxGeometry(width, height, depth, 4, Math.min(width, height, depth) * 0.24),
        material('fuselage', 0.22),
      );
      body.position.copy(position);
      // 실측 상자는 선체의 윗절반만 잡으므로 윗면 높이는 맞다. 윗면을 그대로
      // 두고 아래로만 늘린다. 번들 STL 12개와 대조해 평균 오차 7mm.
      if (part.s) {
        body.position.y = (part.p[2] + part.s[2] / 2) * SCALE - height / 2;
      }
      body.name = part.n;
      group.add(body);
      continue;
    }

    if (name.startsWith('BATTERY')) {
      // 실측이 있는데도 용량으로 추정한 상자를 그리고 있었다. 방향도 맞추지
      // 않아, 눕혀 실린 배터리가 세로로 서서 동체 밖으로 삐져나왔다.
      const size = measured(part);
      const capacity = batteryInfo(draft.energy.batteryTypes[0]).capacity;
      const edit = growth(
        capacity,
        batteryInfo(reference.energy.batteryTypes[0]).capacity,
      );
      const battery = new THREE.Mesh(
        size
          ? new THREE.BoxGeometry(...(size.map((v) => v * edit) as [number, number, number]))
          : new THREE.BoxGeometry(
              0.9 * THREE.MathUtils.clamp(Math.cbrt(capacity / 5000), 0.7, 1.7),
              0.32 * THREE.MathUtils.clamp(Math.cbrt(capacity / 5000), 0.7, 1.7),
              0.5 * THREE.MathUtils.clamp(Math.cbrt(capacity / 5000), 0.7, 1.7),
            ),
        material('energy', 0.05),
      );
      battery.position.copy(position);
      if (size) orientToBasis(battery, part);
      battery.name = part.n;
      group.add(battery);
      continue;
    }

    if (name === 'CARGOCASE') {
      // The source splits the centre body into fuselage plus this case. Skipping
      // it left the middle visibly thinner than the STL.
      const size = measured(part);
      const width = size ? size[0] : Math.max(draft.fuselage.length * SCALE * 0.8, 0.35);
      const height = size ? size[2] : Math.max(draft.fuselage.verticalDiameter * SCALE * 0.5, 0.2);
      const depth = size ? size[1] : Math.max(draft.fuselage.horizontalDiameter * SCALE * 0.55, 0.4);
      const caseMesh = new THREE.Mesh(
        new RoundedBoxGeometry(width, height, depth, 3, Math.min(width, height, depth) * 0.2),
        material('payload', 0.1),
      );
      caseMesh.position.copy(position);
      caseMesh.name = part.n;
      group.add(caseMesh);
      continue;
    }

    if (name.startsWith('CARGO')) {
      // 화물도 실측을 두고 적재량으로 추정한 상자를 쓰고 있었다. 실제 화물은
      // 화물칸을 거의 채우는 크기라 추정치보다 훨씬 크다.
      const size = measured(part);
      const guessed = 0.28 + Math.min(draft.payload.mass, 10) * 0.025;
      const edit = growth(draft.payload.mass, reference.payload.mass);
      const cargo = new THREE.Mesh(
        size
          ? new THREE.BoxGeometry(...(size.map((v) => v * edit) as [number, number, number]))
          : new THREE.BoxGeometry(0.52, guessed, 0.4),
        material('payload', 0.08),
      );
      cargo.position.copy(position);
      if (size) orientToBasis(cargo, part);
      cargo.name = part.n;
      group.add(cargo);
      continue;
    }

    if (name.startsWith('WING')) {
      const wingData = wingParametersFor(part.n);
      // 치수는 파라미터에서 읽는다. 실측 상자를 그대로 쓰면 슬라이더를 움직여도
      // 형상이 그대로였고, 변의 길이 순서로 span·시위를 가르는 방식은 짧고 넓은
      // 날개에서 둘을 뒤바꿨다.
      const span = Math.max((wingData?.span ?? 900) * SCALE, 0.3);
      const root = Math.max((wingData?.chordInner ?? 220) * SCALE, 0.08);
      const tip = Math.max((wingData?.chordOuter ?? 140) * SCALE, 0.04);
      // NACA 네 자리의 끝 두 자리가 시위 대비 두께 비율(%)이다.
      const profileThickness =
        Number(String(wingData?.nacaProfile ?? '').slice(-2)) / 100 || 0.12;

      // 어느 로컬 축으로 뻗는지는 실측 치수가 span과 가장 가까운 축으로 고른다.
      // 단순히 가장 긴 축을 쓰면 19,716장 중 4.7%가 엉뚱한 축을 향했다.
      const basis = basisOf(part);
      const spanIndex = axisNearest(part.s, wingData?.span ?? 900, [0, 1, 2]);
      const rest = [0, 1, 2].filter((index) => index !== spanIndex);
      const chordIndex = axisNearest(part.s, wingData?.chordInner ?? 220, rest);
      const thickIndex = rest.find((index) => index !== chordIndex) ?? rest[0];

      // 좌우 날개는 뻗는 축이 정반대라, 넓은 뿌리를 한쪽으로 고정하면 한 장은
      // 뿌리가 바깥을 향한다. 기체 중심에 가까운 끝을 뿌리로 잡는다.
      const towardCentre = position.lengthSq() > 0
        ? position.clone().negate().normalize()
        : basis[chordIndex];
      const spanAxis = basis[spanIndex].clone();
      if (spanAxis.dot(towardCentre) < 0) spanAxis.negate();

      // 뿌리는 로컬 +X, 시위는 +Z, 두께는 +Y에 놓고 만든 뒤 통째로 돌린다.
      const half = span / 2;
      const rootFront = -root / 2;
      // taperOffset이면 앞전을 일직선으로 두어 뒤쪽만 좁아진다.
      const tipFront = wingData?.taperOffset ? rootFront : -tip / 2;
      const tipBack = tipFront + tip;
      const rootHalfThickness = (root * profileThickness) / 2;
      const tipHalfThickness = (tip * profileThickness) / 2;
      const shape = new THREE.BufferGeometry();
      shape.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            half, rootHalfThickness, rootFront,
            half, rootHalfThickness, root / 2,
            half, -rootHalfThickness, root / 2,
            half, -rootHalfThickness, rootFront,
            -half, tipHalfThickness, tipFront,
            -half, tipHalfThickness, tipBack,
            -half, -tipHalfThickness, tipBack,
            -half, -tipHalfThickness, tipFront,
          ]),
          3,
        ),
      );
      shape.setIndex([
        0, 1, 2, 0, 2, 3, // 뿌리 단면
        4, 7, 6, 4, 6, 5, // 끝단 단면
        0, 4, 5, 0, 5, 1, // 윗면
        3, 2, 6, 3, 6, 7, // 아랫면
        0, 3, 7, 0, 7, 4, // 앞전
        1, 5, 6, 1, 6, 2, // 뒷전
      ]);
      // 꼭짓점을 공유한 채 법선을 구하면 모서리가 뭉개지므로 면마다 분리한다.
      const solid = shape.toNonIndexed();
      solid.computeVertexNormals();
      shape.dispose();
      const wing = new THREE.Mesh(solid, material('wing', 0.18));
      wing.position.copy(position);
      // 세 축을 그대로 회전 행렬로 쓴다. 이전처럼 span축 하나만 맞추면 나머지
      // 회전이 임의로 정해져 시위 방향과 두께 방향이 제멋대로 누웠다.
      const frame = new THREE.Matrix4().makeBasis(
        spanAxis,
        basis[thickIndex],
        basis[chordIndex],
      );
      // 축을 뒤섞으면 좌우가 뒤집힐 수 있다. 두께축은 대칭이라 뒤집어도 무해하다.
      if (frame.determinant() < 0) {
        frame.makeBasis(spanAxis, basis[thickIndex].clone().negate(), basis[chordIndex]);
      }
      wing.quaternion.setFromRotationMatrix(frame);
      wing.name = part.n;
      group.add(wing);
      continue;
    }

    if (name.startsWith('SERVO') || name.startsWith('SENSOR')) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 10, 8),
        material('layout', 0.1),
      );
      marker.position.copy(position);
      marker.name = part.n;
      group.add(marker);
    }
  }

  return group;
}

type HierarchyAnchor = { point: THREE.Vector3; angle: number };
type HierarchyGraph = {
  roots: DesignSegment[];
  children: Map<string, DesignSegment[]>;
};
type ChildInstance = { segment: DesignSegment; angleOffset: number };

/**
 * Exposes the exact cardinality contract used by the renderer. Browser QA can
 * assert that complete AircraftVerse trees need no synthetic radial fallback.
 */
export function analyzeParametricHierarchy(
  draft: DesignDraft,
): ParametricHierarchyDiagnostics {
  const graph = createHierarchyGraph(draft);
  const repetitions = rootRepetitions(draft, graph.roots);
  const count = (
    segment: DesignSegment,
    kind: 'propeller' | 'wing',
  ): number => {
    const local =
      kind === 'propeller'
        ? Number(isPropellerSegment(segment))
        : Number(isWingSegment(segment));
    return (
      local +
      childInstances(segment, graph.children.get(segment.path) ?? []).reduce(
        (sum, child) => sum + count(child.segment, kind),
        0,
      )
    );
  };
  const treePropellerAnchors = graph.roots.reduce(
    (sum, root, index) => sum + count(root, 'propeller') * repetitions[index],
    0,
  );
  const treeWingAnchors = graph.roots.reduce(
    (sum, root, index) => sum + count(root, 'wing') * repetitions[index],
    0,
  );
  const topologyCount = Math.max(
    1,
    Number(draft.topology.match(/Hub(\d+)/)?.[1] ?? 0),
  );
  const desiredPropellers = Math.max(
    draft.numPropellers || draft.propulsionGroups.length || topologyCount,
    1,
  );
  const desiredWings = Math.max(draft.numWings || draft.wings.length, 0);
  return {
    treePropellerAnchors,
    desiredPropellers,
    fallbackPropellers: Math.max(desiredPropellers - treePropellerAnchors, 0),
    surplusPropellers: Math.max(treePropellerAnchors - desiredPropellers, 0),
    treeWingAnchors,
    desiredWings,
    fallbackWings: Math.max(desiredWings - treeWingAnchors, 0),
    surplusWings: Math.max(treeWingAnchors - desiredWings, 0),
  };
}

function buildHierarchicalArms(
  draft: DesignDraft,
  fallbackLength: number,
  deckY: number,
  addArm: (start: THREE.Vector3, end: THREE.Vector3, nodeType: string) => void,
) {
  const graph = createHierarchyGraph(draft);
  const repetitions = rootRepetitions(draft, graph.roots);
  const instanceCount = Math.max(
    repetitions.reduce((sum, value) => sum + value, 0),
    graph.roots.length,
    1,
  );
  const propellerAnchors: HierarchyAnchor[] = [];
  const wingAnchors: HierarchyAnchor[] = [];
  let maxReach = 0;
  let rootInstance = 0;

  // `_Sym` hubs mirror every second copy instead of repeating one bend around
  // the circle. Source STLs show three mirrored pairs, not six equal spokes.
  const mirrored = /_Sym/i.test(draft.topology);

  const walk = (
    segment: DesignSegment,
    start: THREE.Vector3,
    direction: number,
    mirror: number,
  ) => {
    const traced = traceSegment(
      segment,
      start,
      direction,
      fallbackLength,
      addArm,
      mirror,
    );
    maxReach = Math.max(maxReach, Math.hypot(traced.end.x, traced.end.z));
    if (isPropellerSegment(segment)) {
      propellerAnchors.push({
        point: traced.end.clone(),
        angle: traced.outgoing,
      });
    }
    if (isWingSegment(segment)) {
      wingAnchors.push({ point: traced.end.clone(), angle: traced.outgoing });
    }
    const children = graph.children.get(segment.path) ?? [];
    childInstances(segment, children).forEach((child) => {
      walk(
        child.segment,
        traced.end,
        traced.outgoing + child.angleOffset * mirror,
        mirror,
      );
    });
  };

  const step = (Math.PI * 2) / instanceCount;
  const half = Math.ceil(instanceCount / 2);

  for (let rootIndex = 0; rootIndex < graph.roots.length; rootIndex += 1) {
    for (let copy = 0; copy < repetitions[rootIndex]; copy += 1) {
      // A symmetric hub folds one half onto the other across a single axis, so
      // the second half reuses the first half's slots with the bend reversed.
      const side = !mirrored || rootInstance < half ? 1 : -1;
      const slot = side === 1 ? rootInstance : rootInstance - half;
      const direction = mirrored
        ? side * (slot + 0.5) * step
        : rootInstance * step;
      const start = new THREE.Vector3(
        Math.cos(direction) * 0.25,
        deckY,
        Math.sin(direction) * 0.25,
      );
      walk(graph.roots[rootIndex], start, direction, side);
      rootInstance += 1;
    }
  }
  return {
    propellerAnchors,
    wingAnchors,
    maxReach: Math.max(maxReach, fallbackLength * SCALE),
  };
}

function createHierarchyGraph(draft: DesignDraft): HierarchyGraph {
  const segments = draft.segments.filter((segment) => segment.length > 0);
  const byPath = new Map(segments.map((segment) => [segment.path, segment]));
  const children = new Map<string, DesignSegment[]>();
  const roots: DesignSegment[] = [];
  for (const segment of segments) {
    const declaredParent =
      segment.parentPath && byPath.has(segment.parentPath)
        ? segment.parentPath
        : null;
    const inferredParent =
      declaredParent ??
      segments
        .filter(
          (candidate) =>
            candidate.path !== segment.path &&
            segment.path.startsWith(`${candidate.path}.`),
        )
        .sort((left, right) => right.path.length - left.path.length)[0]?.path ??
      null;
    if (!inferredParent) {
      roots.push(segment);
      continue;
    }
    const bucket = children.get(inferredParent) ?? [];
    bucket.push(segment);
    children.set(inferredParent, bucket);
  }
  // The preprocessor preserves source-object insertion order. That order is
  // significant for asymmetric hub suffixes such as Hub6_1_2_2_1.
  return { roots, children };
}

function rootRepetitions(draft: DesignDraft, roots: DesignSegment[]) {
  const hubBranches = Math.max(
    1,
    Number(draft.topology.match(/Hub(\d+)/)?.[1] ?? roots.length ?? 1),
  );
  if (/ConnectedHub3_2_1/i.test(draft.topology)) {
    // This hub stores the unique centre template first, while its topology
    // suffix describes the paired main slot before the centre slot.
    return roots.map((root) => (root.slot === 'mainSegment' ? 2 : 1));
  }
  if (/Sym/i.test(draft.topology) && roots.length === 1) {
    return roots.map(() => hubBranches);
  }
  const suffixMultiplicities = draft.topology
    .replace(/^.*?Hub\d+_?/, '')
    .split('_')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return roots.map((_, index) =>
    suffixMultiplicities.length === roots.length
      ? suffixMultiplicities[index]
      : 1,
  );
}

function childInstances(
  segment: DesignSegment,
  children: DesignSegment[],
): ChildInstance[] {
  const main = children.find((child) => child.slot === 'mainSegment');
  const top = children.find((child) => child.slot === 'topSegment');
  const side = children.find((child) => child.slot === 'sideSegment');
  const center = children.find((child) => child.slot === 'centerSegment');
  const spread = THREE.MathUtils.degToRad(
    Math.max(Math.abs(segment.angle || 60), 24),
  );
  const remaining = (...excluded: Array<DesignSegment | undefined>) =>
    children
      .filter((child) => !excluded.includes(child))
      .map((child, index, siblings) => ({
        segment: child,
        angleOffset: explicitChildOffset(child, index, siblings.length, spread),
      }));

  if (segment.nodeType === 'BranchSegment_Sym' && main) {
    return [
      { segment: main, angleOffset: spread * 0.5 },
      { segment: main, angleOffset: -spread * 0.5 },
      ...remaining(main),
    ];
  }
  if (segment.nodeType === 'BranchWithTopSegment_Sym' && main) {
    return [
      { segment: main, angleOffset: spread * 0.5 },
      { segment: main, angleOffset: -spread * 0.5 },
      ...(top ? [{ segment: top, angleOffset: 0 }] : []),
      ...remaining(main, top),
    ];
  }
  if (segment.nodeType === 'CrossSegment' && side) {
    return [
      { segment: side, angleOffset: Math.PI * 0.5 },
      { segment: side, angleOffset: -Math.PI * 0.5 },
      ...(center ? [{ segment: center, angleOffset: 0 }] : []),
      ...remaining(side, center),
    ];
  }
  if (segment.nodeType === 'SidewaysBendWithTopSegment') {
    return children.map((child, index) => ({
      segment: child,
      angleOffset:
        child.slot === 'mainSegment'
          ? THREE.MathUtils.degToRad(segment.angle || 0)
          : explicitChildOffset(child, index, children.length, spread),
    }));
  }
  return children.map((child, index) => ({
    segment: child,
    angleOffset: explicitChildOffset(child, index, children.length, spread),
  }));
}

function explicitChildOffset(
  child: DesignSegment,
  index: number,
  siblingCount: number,
  spread: number,
) {
  const slot = child.slot.toLowerCase();
  if (slot.includes('left') || slot.includes('front')) return spread * 0.5;
  if (slot.includes('right') || slot.includes('rear')) return -spread * 0.5;
  if (slot.includes('side')) return spread;
  if (slot.includes('main') || slot.includes('center') || slot.includes('top'))
    return 0;
  return siblingCount > 1
    ? (index - (siblingCount - 1) / 2) * spread * 0.55
    : 0;
}

function traceSegment(
  segment: DesignSegment,
  start: THREE.Vector3,
  direction: number,
  fallbackLength: number,
  addArm: (start: THREE.Vector3, end: THREE.Vector3, nodeType: string) => void,
  mirror = 1,
) {
  const bendAngle = (segment.angle || 0) * mirror;
  const requestedLength = Math.max(
    (segment.length || fallbackLength) * SCALE,
    0.35,
  );
  const arm1 = Number(segment.parameters.arm1Length) || 0;
  const arm2 = Number(segment.parameters.arm2Length) || 0;
  const hasTwoPieceArm = arm1 > 0 && arm2 > 0;
  let end: THREE.Vector3;
  let outgoing = direction;

  if (hasTwoPieceArm) {
    const scaleToRequested =
      requestedLength / Math.max((arm1 + arm2) * SCALE, 0.001);
    const firstLength = arm1 * SCALE * scaleToRequested;
    const secondLength = arm2 * SCALE * scaleToRequested;
    const elbow = new THREE.Vector3(
      start.x + Math.cos(direction) * firstLength,
      start.y,
      start.z + Math.sin(direction) * firstLength,
    );
    addArm(start, elbow, segment.nodeType);
    if (segment.nodeType === 'DoubleBendSegment') {
      outgoing = direction + THREE.MathUtils.degToRad(bendAngle);
      end = new THREE.Vector3(
        elbow.x + Math.cos(outgoing) * secondLength,
        elbow.y,
        elbow.z + Math.sin(outgoing) * secondLength,
      );
    } else {
      // Angled terminal arms have no variable bend angle in the source tree;
      // a shallow elevation communicates the envelope without inventing yaw.
      const elevation = /Angled/i.test(segment.nodeType) ? 0.18 : 0;
      end = new THREE.Vector3(
        elbow.x + Math.cos(direction) * secondLength * Math.cos(elevation),
        elbow.y + secondLength * Math.sin(elevation),
        elbow.z + Math.sin(direction) * secondLength * Math.cos(elevation),
      );
    }
    addArm(elbow, end, segment.nodeType);
  } else {
    end = new THREE.Vector3(
      start.x + Math.cos(direction) * requestedLength,
      start.y,
      start.z + Math.sin(direction) * requestedLength,
    );
    addArm(start, end, segment.nodeType);
    if (/^(?:BendSegment|SidewaysBendSegment)$/i.test(segment.nodeType)) {
      outgoing = direction + THREE.MathUtils.degToRad(bendAngle);
    }
  }

  // `segment.offset` is a small real-world mounting-bracket displacement
  // (a few centimetres, absorbed inside the arm's own housing on a real
  // drone). Drawing it as a visible strut made the propeller look like it
  // was bolted on sideways, so this simplified concept view intentionally
  // keeps the motor/propeller in line with the arm instead of displacing it.
  return { end, outgoing };
}

function isPropellerSegment(segment: DesignSegment) {
  return Boolean(
    segment.motorType ||
    segment.propellerType ||
    /Prop/i.test(segment.nodeType),
  );
}

function isWingSegment(segment: DesignSegment) {
  return Boolean(segment.wing || /WingArm/i.test(segment.nodeType));
}

function buildForceVectors(vectors?: ForceVectors) {
  const group = new THREE.Group();
  const drag = Math.max(vectors?.drag ?? 0, 0);
  const lift = Math.max(vectors?.lift ?? 0, 0);
  const thrust = Math.max(vectors?.thrust ?? 0, 0);
  const max = Math.max(drag, lift, thrust, 1);
  if (drag > 0)
    group.add(
      new THREE.ArrowHelper(
        new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0.8, 0),
        1.2 + (drag / max) * 1.8,
        0xe97942,
        0.24,
        0.14,
      ),
    );
  if (lift > 0)
    group.add(
      new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0.8, 0),
        1.2 + (lift / max) * 1.8,
        0x1c9b62,
        0.24,
        0.14,
      ),
    );
  if (thrust > 0)
    group.add(
      new THREE.ArrowHelper(
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0.8, 0),
        1.2 + (thrust / max) * 1.8,
        0x6d5bd0,
        0.24,
        0.14,
      ),
    );
  return group;
}

function cylinderBetween(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
) {
  const direction = end.clone().sub(start);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 16),
    material,
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.clone().normalize(),
  );
  return mesh;
}

function propellerSize(value?: string) {
  const normalized = value?.replace(/_(\d)(?=[A-Za-z]|$)/g, '.$1') ?? '';
  const match = normalized.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/i);
  return {
    diameter: THREE.MathUtils.clamp(Number(match?.[1] ?? 14), 7, 32),
    pitch: THREE.MathUtils.clamp(Number(match?.[2] ?? 6), 2, 18),
  };
}

function motorRadius(value?: string) {
  const match = value?.match(/(\d{2})(\d{2})/);
  return THREE.MathUtils.clamp(
    Number(match?.[1] ?? 35) * SCALE * 0.5,
    0.12,
    0.32,
  );
}

function batteryInfo(value?: string) {
  return {
    capacity: Number(value?.match(/(\d{3,6})mAh/i)?.[1] ?? 5000),
    cells: Number(value?.match(/(\d{1,2})S/i)?.[1] ?? 4),
  };
}

function disposeObject(object: THREE.Object3D | null | undefined) {
  if (!object) return;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.Line))
      return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    materials.forEach((item) => item?.dispose());
  });
}
