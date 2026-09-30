'use client';

import { useEffect, useRef, useState } from 'react';
import { MousePointer2, Pause, Play, RefreshCw } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { Button } from '@/components/ui/button';
import { broadcastViewerCamera, registerViewerCamera } from '@/lib/viewer-camera-sync';
import { configureInfiniteGrid, createInfiniteGrid, disposeInfiniteGrid, updateInfiniteGrid } from '@/lib/three-infinite-grid';

const AUTO_ROTATE_STORAGE_KEY = 'drawn-stl-auto-rotate';

type StlViewerProps = {
  src: string;
  pitchDegrees?: number | null;
  forceVectors?: {
    drag?: number | null;
    lift?: number | null;
    thrust?: number | null;
  };
  showForceVectors?: boolean;
  cameraFitPadding?: number;
  cameraSync?: { group: string; id: string; linked: boolean };
  /** 값이 바뀔 때 설계 원점을 바라보는 홈 카메라로 돌아간다. */
  cameraResetKey?: number;
  showControls?: boolean;
  /** 다른 전체 화면 UI에 가려졌을 때 WebGL 렌더링만 일시 정지한다. */
  paused?: boolean;
};

export function StlViewer({
  src,
  pitchDegrees = 0,
  forceVectors,
  showForceVectors = false,
  cameraFitPadding = 1.62,
  cameraSync,
  cameraResetKey = 0,
  showControls = true,
  paused = false,
}: StlViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const dynamicsRef = useRef({ pitchDegrees, forceVectors, showForceVectors });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const [autoRotate, setAutoRotate] = useState(true);
  const autoRotateRef = useRef(true);
  const pausedRef = useRef(paused);
  const cameraSyncRef = useRef(cameraSync);
  const resetCameraRef = useRef<() => void>(() => {});

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    cameraSyncRef.current = cameraSync;
  }, [cameraSync]);

  useEffect(() => {
    let active = true;
    try {
      const enabled = localStorage.getItem(AUTO_ROTATE_STORAGE_KEY) !== 'false';
      autoRotateRef.current = enabled;
      queueMicrotask(() => { if (active) setAutoRotate(enabled); });
    } catch { /* Keep the default if browser storage is unavailable. */ }
    return () => { active = false; };
  }, []);

  const toggleAutoRotate = () => {
    const enabled = !autoRotateRef.current;
    autoRotateRef.current = enabled;
    setAutoRotate(enabled);
    try { localStorage.setItem(AUTO_ROTATE_STORAGE_KEY, String(enabled)); }
    catch { /* The toggle still works for this viewer without persistence. */ }
  };

  useEffect(() => {
    dynamicsRef.current = { pitchDegrees, forceVectors, showForceVectors };
  }, [forceVectors, pitchDegrees, showForceVectors]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef3f6);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10000);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      window.setTimeout(() => {
        setStatus('error');
        setErrorMessage('이 브라우저에서 WebGL을 시작하지 못했습니다.');
      }, 0);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      'aria-label',
      'UAV 3D model viewer. 방향키로 회전 및 확대/축소',
    );
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.55;
    controls.enablePan = true;
    // 파라메트릭 뷰와 동일하게 커서 아래 형상을 향해 확대한다.
    controls.zoomToCursor = true;
    const movementKeys = new Set<string>();
    const panVelocity = new THREE.Vector2();
    let lastMovementAt = 0;
    const handleKeyboard = (event: KeyboardEvent) => {
      const offset = camera.position.clone().sub(controls.target);
      const key = event.key.toLowerCase();
      if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
        movementKeys.add(key);
        event.preventDefault();
        return;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), event.key === 'ArrowLeft' ? 0.12 : -0.12);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        offset.multiplyScalar(event.key === 'ArrowUp' ? 0.9 : 1.1);
      } else {
        return;
      }
      event.preventDefault();
      camera.position.copy(controls.target).add(offset);
      controls.update();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      movementKeys.delete(event.key.toLowerCase());
    };
    const stopKeyboardMovement = () => movementKeys.clear();
    const updateKeyboardMovement = (time: number) => {
      const delta = lastMovementAt
        ? Math.min(Math.max((time - lastMovementAt) / 1000, 0), 0.05)
        : 0;
      lastMovementAt = time;
      const input = new THREE.Vector2(
        Number(movementKeys.has('d')) - Number(movementKeys.has('a')),
        Number(movementKeys.has('w')) - Number(movementKeys.has('s')),
      );
      if (input.lengthSq() > 1) input.normalize();
      const distance = camera.position.distanceTo(controls.target);
      const desired = input.multiplyScalar(Math.max(distance * 0.294, 0.56));
      panVelocity.lerp(desired, 1 - Math.exp(-10 * delta));
      if (!movementKeys.size && panVelocity.lengthSq() < 1e-5) {
        panVelocity.set(0, 0);
        return;
      }
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      const move = right
        .multiplyScalar(panVelocity.x * delta)
        .addScaledVector(up, panVelocity.y * delta);
      camera.position.add(move);
      controls.target.add(move);
    };
    renderer.domElement.addEventListener('keydown', handleKeyboard);
    window.addEventListener('keyup', handleKeyUp);
    renderer.domElement.addEventListener('blur', stopKeyboardMovement);
    const focusCanvas = () => renderer.domElement.focus({ preventScroll: true });
    renderer.domElement.addEventListener('pointerdown', focusCanvas);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x91a9b6, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 3.6);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x86d8df, 2.2);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const grid = createInfiniteGrid(-0.9);
    scene.add(grid.mesh);

    const modelPivot = new THREE.Group();
    scene.add(modelPivot);

    const forceGroup = new THREE.Group();
    const dragArrow = new THREE.ArrowHelper(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(), 1, 0x147d91, 0.18, 0.1);
    const liftArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0xc47a13, 0.18, 0.1);
    const thrustArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x178653, 0.18, 0.1);
    forceGroup.add(dragArrow, liftArrow, thrustArrow);
    forceGroup.visible = false;
    scene.add(forceGroup);

    let model: THREE.Mesh | null = null;
    let frame = 0;
    let resizeFrame = 0;
    let disposed = false;
    let modelRadius = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let lastDynamics = '';
    let applyingCamera = false;
    const homeTarget = new THREE.Vector3();
    let homeDistance = 0;

    const updateDynamics = () => {
      const dynamics = dynamicsRef.current;
      const pitch = Number.isFinite(dynamics.pitchDegrees) ? Number(dynamics.pitchDegrees) : 0;
      const drag = Math.max(0, Number(dynamics.forceVectors?.drag) || 0);
      const lift = Math.max(0, Number(dynamics.forceVectors?.lift) || 0);
      const thrust = Math.max(0, Number(dynamics.forceVectors?.thrust) || 0);
      const signature = `${pitch}|${drag}|${lift}|${thrust}|${dynamics.showForceVectors}|${modelRadius}`;
      if (signature === lastDynamics) return;
      lastDynamics = signature;

      modelPivot.rotation.z = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pitch, -45, 45));
      forceGroup.visible = Boolean(dynamics.showForceVectors && modelRadius && (drag || lift || thrust));
      if (!forceGroup.visible) return;

      const maximum = Math.max(drag, lift, thrust, 1);
      const arrowLength = (value: number) => modelRadius * (0.55 + (value / maximum) * 0.85);
      const headLength = Math.max(modelRadius * 0.17, 0.1);
      const headWidth = Math.max(modelRadius * 0.1, 0.06);
      dragArrow.position.set(-modelRadius * 0.12, modelRadius * 0.24, 0);
      liftArrow.position.set(0, modelRadius * 0.12, 0);
      thrustArrow.position.set(modelRadius * 0.12, modelRadius * 0.24, 0);
      dragArrow.setLength(arrowLength(drag), headLength, headWidth);
      liftArrow.setLength(arrowLength(lift), headLength, headWidth);
      thrustArrow.setLength(arrowLength(thrust), headLength, headWidth);
    };

    const fitCamera = () => {
      if (!modelRadius || !model) return;
      modelPivot.updateWorldMatrix(true, true);
      const positions = model.geometry.getAttribute('position');
      if (!positions) return;
      const points: THREE.Vector3[] = [];
      // 회전된 날개처럼 비어 있는 AABB 모서리를 사용하면 실제보다 훨씬 큰
      // 형상으로 계산되어 듀얼 뷰의 STL만 작아진다. 실제 STL 꼭짓점으로 맞춘다.
      for (let index = 0; index < positions.count; index += 1) {
        points.push(
          new THREE.Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(model.matrixWorld),
        );
      }
      const box = new THREE.Box3().setFromPoints(points);
      // 파라메트릭 뷰와 동일하게 설계 좌표 원점을 홈 주시점으로 사용한다.
      const centre = new THREE.Vector3();
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1);
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const view = new THREE.Vector3(1.12, 0.88, 1.2).normalize();
      const right = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0)).normalize();
      const up = new THREE.Vector3().crossVectors(right, view);
      const spanWide = Math.tan(horizontalFov / 2);
      const spanHigh = Math.tan(verticalFov / 2);
      let distance = 0;
      for (const point of points) {
        const local = point.clone().sub(centre);
        const depth = local.dot(view);
        distance = Math.max(
          distance,
          Math.abs(local.dot(right)) / spanWide + depth,
          Math.abs(local.dot(up)) / spanHigh + depth,
        );
      }
      distance = Math.max(distance * cameraFitPadding, radius * 0.6);

      camera.position.copy(view.clone().multiplyScalar(distance).add(centre));
      camera.near = Math.max(radius / 100, 0.02);
      camera.far = Math.max(distance + radius * 10, 100);
      camera.updateProjectionMatrix();
      controls.target.copy(centre);
      homeTarget.copy(centre);
      controls.minDistance = Math.max(radius * 0.55, 1.5);
      controls.maxDistance = Math.max(radius * 8, 12);
      controls.update();
      homeDistance = camera.position.distanceTo(controls.target);
      const sync = cameraSyncRef.current;
      if (sync?.linked) {
        window.queueMicrotask(() => broadcastViewerCamera(sync.group, sync.id));
      }
      configureInfiniteGrid(grid, {
        step: Math.max(radius / 7, 0.65),
        fadeDistance: Math.max(radius * 14, 45),
      });
      updateInfiniteGrid(grid, camera);
    };
    resetCameraRef.current = fitCamera;

    const externalGroup = cameraSync?.group;
    const externalId = cameraSync?.id;
    const unregisterExternal = externalGroup && externalId
      ? registerViewerCamera(externalGroup, externalId, {
          read: () => {
            if (!modelRadius || !homeDistance) return null;
            const scale = 1 / modelRadius;
            const offset = camera.position.clone().sub(controls.target);
            return {
              direction: offset.clone().normalize().toArray(),
              distanceScale: offset.length() / homeDistance,
              targetOffset: controls.target.clone().sub(homeTarget).multiplyScalar(scale).toArray(),
              zoom: camera.zoom,
            };
          },
          apply: (pose) => {
            if (!modelRadius || !homeDistance) return;
            applyingCamera = true;
            controls.target.copy(homeTarget).add(new THREE.Vector3(...pose.targetOffset).multiplyScalar(modelRadius));
            camera.position.copy(controls.target).add(new THREE.Vector3(...pose.direction).multiplyScalar(homeDistance * pose.distanceScale));
            camera.zoom = pose.zoom;
            camera.updateProjectionMatrix();
            controls.update();
            applyingCamera = false;
          },
        })
      : null;
    const syncExternalCamera = () => {
      const config = cameraSyncRef.current;
      if (!config?.linked || applyingCamera) return;
      broadcastViewerCamera(config.group, config.id);
    };
    controls.addEventListener('change', syncExternalCamera);

    const resize = () => {
      const width = Math.max(1, Math.floor(mount.clientWidth));
      const height = Math.max(1, Math.floor(mount.clientHeight));
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      fitCamera();
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(mount);
    resize();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (disposed) return;
      setStatus('error');
      setErrorMessage('3D 그래픽 연결이 중단되었습니다. 다시 시도해 주세요.');
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    new STLLoader().load(
      src,
      (geometry) => {
        if (disposed) {
          geometry.dispose();
          return;
        }
        geometry.computeVertexNormals();
        geometry.center();
        geometry.computeBoundingSphere();
        const radius = Math.max(geometry.boundingSphere?.radius ?? 1, 1);
        modelRadius = radius * 0.01;
        model = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0x93d4dc,
            metalness: 0.24,
            roughness: 0.44,
            side: THREE.DoubleSide,
          }),
        );
        model.scale.setScalar(0.01);
        model.rotation.x = -Math.PI / 2;
        model.position.y = modelRadius * 0.12;
        modelPivot.add(model);
        updateDynamics();
        fitCamera();
        setStatus('ready');
      },
      undefined,
      () => {
        if (disposed) return;
        setStatus('error');
        setErrorMessage('3D 모델 파일을 불러오지 못했습니다.');
      },
    );

    const animate = (time = 0) => {
      if (!pausedRef.current) {
        updateKeyboardMovement(time);
        updateDynamics();
        controls.autoRotate = autoRotateRef.current && !cameraSyncRef.current?.linked;
        controls.update();
        updateInfiniteGrid(grid, camera);
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('keydown', handleKeyboard);
      window.removeEventListener('keyup', handleKeyUp);
      renderer.domElement.removeEventListener('blur', stopKeyboardMovement);
      renderer.domElement.removeEventListener('pointerdown', focusCanvas);
      controls.dispose();
      controls.removeEventListener('change', syncExternalCamera);
      unregisterExternal?.();
      model?.geometry.dispose();
      if (model?.material && !Array.isArray(model.material)) model.material.dispose();
      for (const arrow of [dragArrow, liftArrow, thrustArrow]) {
        arrow.line.geometry.dispose();
        const lineMaterials = Array.isArray(arrow.line.material) ? arrow.line.material : [arrow.line.material];
        lineMaterials.forEach((material) => material.dispose());
        arrow.cone.geometry.dispose();
        const coneMaterials = Array.isArray(arrow.cone.material) ? arrow.cone.material : [arrow.cone.material];
        coneMaterials.forEach((material) => material.dispose());
      }
      disposeInfiniteGrid(grid);
      renderer.dispose();
      renderer.domElement.remove();
      resetCameraRef.current = () => {};
    };
  }, [cameraFitPadding, cameraSync?.group, cameraSync?.id, retryKey, src]);

  useEffect(() => {
    if (cameraResetKey > 0) resetCameraRef.current();
  }, [cameraResetKey]);

  return (
    <div
      ref={mountRef}
      data-viewer-status={status}
      data-pitch-degrees={Number.isFinite(pitchDegrees) ? pitchDegrees : 0}
      data-force-drag={forceVectors?.drag ?? ''}
      data-force-lift={forceVectors?.lift ?? ''}
      data-force-thrust={forceVectors?.thrust ?? ''}
      className="absolute inset-0 overflow-hidden"
    >
      {status === 'ready' && showControls && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-20 flex flex-wrap items-center justify-between gap-2">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-[#e5e5ea] bg-white/90 px-3 text-[11px] text-[#6e6e73] shadow-sm backdrop-blur">
            <MousePointer2 className="size-3" /> 드래그 회전 · 스크롤 확대
          </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="3D 자동 회전"
          aria-pressed={autoRotate}
          onClick={toggleAutoRotate}
          className={`pointer-events-auto h-9 gap-2 rounded-lg border-2 px-3 text-xs font-bold shadow-md transition-colors ${autoRotate
            ? 'border-[#1b64da] bg-[#3182f6] text-white hover:border-[#153e8a] hover:bg-[#1b64da] hover:text-white'
            : 'border-[#b7791f] bg-[#fff4db] text-[#80510d] hover:border-[#965f13] hover:bg-[#ffe8b3] hover:text-[#694008]'
          }`}
        >
          {autoRotate ? <Pause /> : <Play />}
          자동 회전 {autoRotate ? '켜짐' : '꺼짐'}
        </Button>
        </div>
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 grid place-items-center text-xs font-semibold tracking-[0.12em] text-[#6e6e73]">
          원본 STL 불러오는 중
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/90 p-6 text-center backdrop-blur-sm">
          <div>
            <p className="text-sm font-medium text-amber-800">{errorMessage || '3D 모델을 불러오지 못했습니다.'}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStatus('loading');
                setErrorMessage('');
                setRetryKey((value) => value + 1);
              }}
              className="mt-4 border-amber-200 bg-white text-amber-900 hover:bg-amber-50"
            >
              <RefreshCw /> 다시 시도
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
