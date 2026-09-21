'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { Button } from '@/components/ui/button';
import type {
  DesignDraft,
  DesignSegment,
  ParameterGroup,
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

      runtime.model = buildAircraft(draft, changedGroup, false);
      runtime.model.rotation.z = THREE.MathUtils.degToRad(pitchDegrees);
      runtime.scene.add(runtime.model);

      if (showGhost && baseline) {
        runtime.ghost = buildAircraft(baseline, null, true);
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

function buildAircraft(
  draft: DesignDraft,
  changedGroup: ParameterGroup | null,
  ghost: boolean,
) {
  const group = new THREE.Group();
  group.name = ghost ? 'baseline-ghost' : 'editable-aircraft';

  const colors = {
    structure: 0x167f91,
    fuselage: 0xe7eef1,
    propulsion: 0x233a49,
    energy: 0x6d5bd0,
    wing: 0x82c4ce,
    payload: 0xe7a33e,
    layout: 0x1c9b62,
  } as const;
  const material = (kind: keyof typeof colors, metalness = 0.12) => {
    const active = changedGroup === kind;
    return new THREE.MeshStandardMaterial({
      color: ghost ? 0x7f96a2 : colors[kind],
      roughness: ghost ? 0.8 : 0.48,
      metalness: ghost ? 0 : metalness,
      transparent: ghost,
      opacity: ghost ? 0.16 : 1,
      depthWrite: !ghost,
      emissive: !ghost && active ? colors[kind] : 0x000000,
      emissiveIntensity: !ghost && active ? 0.28 : 0,
      side: THREE.DoubleSide,
    });
  };

  const fuselage = draft.fuselage;
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(1, 36, 22),
    material('fuselage', 0.22),
  );
  body.name = 'fuselage';
  body.scale.set(
    Math.max(fuselage.length * SCALE * 0.5, 0.65),
    Math.max(fuselage.verticalDiameter * SCALE * 0.5, 0.34),
    Math.max(fuselage.horizontalDiameter * SCALE * 0.5, 0.78),
  );
  body.position.y = 0.42;
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
  hub.position.y = 0.78;
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
      0.73,
      Math.sin(angle) * 0.25,
    );
    const end = new THREE.Vector3(
      Math.cos(angle) * length,
      0.76,
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
    motor.position.copy(end).add(new THREE.Vector3(0, 0.15, 0));
    motor.name = `motor-${index + 1}`;
    group.add(motor);

    const { diameter, pitch } = propellerSize(propulsionGroup?.propellerType);
    const rotor = new THREE.Group();
    rotor.name = `propeller-${index + 1}`;
    rotor.position.copy(end).add(new THREE.Vector3(0, 0.34, 0));
    const rotorRadius = diameter * 25.4 * SCALE * 0.5;
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
    battery.position.set(
      (index - (batteryTypes.length - 1) / 2) * 0.65,
      0.45,
      0,
    );
    group.add(battery);
  });

  if (draft.payload.mass > 0) {
    const payload = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.52,
        0.28 + Math.min(draft.payload.mass, 10) * 0.025,
        0.4,
      ),
      material('payload', 0.08),
    );
    payload.name = 'payload';
    payload.position.set(0, -0.18, 0);
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
      sensor.position.set(position.x * SCALE, 0.75, position.y * SCALE);
      group.add(sensor);
    });

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

  const walk = (
    segment: DesignSegment,
    start: THREE.Vector3,
    direction: number,
  ) => {
    const traced = traceSegment(
      segment,
      start,
      direction,
      fallbackLength,
      addArm,
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
      walk(child.segment, traced.end, traced.outgoing + child.angleOffset);
    });
  };

  for (let rootIndex = 0; rootIndex < graph.roots.length; rootIndex += 1) {
    for (let copy = 0; copy < repetitions[rootIndex]; copy += 1) {
      const direction = (rootInstance / instanceCount) * Math.PI * 2;
      const start = new THREE.Vector3(
        Math.cos(direction) * 0.25,
        0.73,
        Math.sin(direction) * 0.25,
      );
      walk(graph.roots[rootIndex], start, direction);
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
) {
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
      outgoing = direction + THREE.MathUtils.degToRad(segment.angle || 0);
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
      outgoing = direction + THREE.MathUtils.degToRad(segment.angle || 0);
    }
  }

  const lateralOffset = (segment.offset || 0) * SCALE;
  end.x -= Math.sin(outgoing) * lateralOffset;
  end.z += Math.cos(outgoing) * lateralOffset;
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
