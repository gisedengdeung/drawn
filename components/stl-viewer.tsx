'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { Button } from '@/components/ui/button';

type StlViewerProps = {
  src: string;
};

export function StlViewer({ src }: StlViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
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
    renderer.domElement.setAttribute('aria-label', 'UAV 3D model viewer');
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;
    controls.enablePan = true;

    scene.add(new THREE.HemisphereLight(0xc9f9ff, 0x07101d, 2.2));
    const key = new THREE.DirectionalLight(0xe9fdff, 4.2);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6e77ff, 3.4);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const grid = new THREE.GridHelper(1200, 16, 0x1b6979, 0x12323d);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.28;
    });
    scene.add(grid);

    let model: THREE.Mesh | null = null;
    let frame = 0;
    let resizeFrame = 0;
    let disposed = false;
    let modelRadius = 0;
    let lastWidth = 0;
    let lastHeight = 0;

    const fitCamera = () => {
      if (!modelRadius) return;
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const limitingFov = Math.max(Math.min(verticalFov, horizontalFov), 0.1);
      const distance = (modelRadius / Math.sin(limitingFov / 2)) * 1.15;
      const direction = new THREE.Vector3(1.25, 0.95, 1.4).normalize();

      camera.position.copy(direction.multiplyScalar(distance));
      camera.near = Math.max(modelRadius / 100, 0.01);
      camera.far = Math.max(distance + modelRadius * 8, modelRadius * 20);
      camera.updateProjectionMatrix();
      controls.target.set(0, modelRadius * 0.12, 0);
      controls.minDistance = modelRadius * 0.8;
      controls.maxDistance = modelRadius * 7;
      controls.update();

      const gridScale = Math.max((modelRadius * 4) / 1200, 0.2);
      grid.scale.setScalar(gridScale);
      grid.position.y = -modelRadius * 0.03;
    };

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
        modelRadius = radius;
        model = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0xcceff2,
            metalness: 0.48,
            roughness: 0.3,
            side: THREE.DoubleSide,
          }),
        );
        model.rotation.x = -Math.PI / 2;
        model.position.y = radius * 0.12;
        scene.add(model);
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
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      controls.dispose();
      model?.geometry.dispose();
      if (model?.material && !Array.isArray(model.material)) model.material.dispose();
      grid.geometry.dispose();
      gridMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [retryKey, src]);

  return (
    <div
      ref={mountRef}
      data-viewer-status={status}
      className="absolute inset-0 overflow-hidden"
    >
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 grid place-items-center text-xs font-medium uppercase tracking-[0.18em] text-cyan-200/70">
          Loading aircraft mesh
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-[#07111d]/80 p-6 text-center backdrop-blur-sm">
          <div>
            <p className="text-sm text-amber-200">{errorMessage || '3D 모델을 불러오지 못했습니다.'}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setStatus('loading');
                setErrorMessage('');
                setRetryKey((value) => value + 1);
              }}
              className="mt-4 border-amber-200/20 bg-amber-200/5 text-amber-100 hover:bg-amber-200/10"
            >
              <RefreshCw /> 다시 시도
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
