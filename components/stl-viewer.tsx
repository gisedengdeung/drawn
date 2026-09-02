'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

type StlViewerProps = {
  src: string;
};

export function StlViewer({ src }: StlViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
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

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(mount);
    resize();

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
        model = new THREE.Mesh(
          geometry,
          new THREE.MeshStandardMaterial({
            color: 0xcceff2,
            metalness: 0.72,
            roughness: 0.24,
          }),
        );
        model.rotation.x = -Math.PI / 2;
        model.position.y = radius * 0.12;
        scene.add(model);
        camera.position.set(radius * 1.25, radius * 0.95, radius * 1.4);
        camera.near = radius / 100;
        camera.far = radius * 20;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.minDistance = radius * 0.65;
        controls.maxDistance = radius * 5;
        controls.update();
        setStatus('ready');
      },
      undefined,
      () => setStatus('error'),
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
      controls.dispose();
      model?.geometry.dispose();
      if (model?.material && !Array.isArray(model.material)) model.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src]);

  return (
    <div ref={mountRef} className="relative h-full min-h-[320px] w-full overflow-hidden">
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 grid place-items-center text-xs font-medium uppercase tracking-[0.18em] text-cyan-200/70">
          Loading aircraft mesh
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 grid place-items-center text-sm text-amber-200">
          3D 모델을 불러오지 못했습니다.
        </div>
      )}
    </div>
  );
}
