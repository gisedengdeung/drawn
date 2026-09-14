"use client";

import React, { useEffect, useRef } from "react";
import * as THREE from "three";
import { DroneSkin } from "@/lib/skin-data";

interface SkinPreviewProps {
  selectedSkin: DroneSkin;
}

export default function SkinPreview({ selectedSkin }: SkinPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textureRef = useRef<THREE.CanvasTexture | THREE.Texture | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // 1. Scene / Camera / Renderer 기본 설정
    const width = containerRef.current.clientWidth;
    const height = containerRef.current.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a); // slate-900 배경색

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 0, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    // 기존 캔버스 제거 후 추가
    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(renderer.domElement);

    // 2. 조명 설정
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);

    // 3. 더미 드론/박스 메쉬 생성 (실제 UAV 3D 모델로 대체 가능)
    const geometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);
    
    // 기본 텍스처 생성 (이미지가 로드되기 전 기본 단색/체커보드)
    const material = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      roughness: 0.4,
      metalness: 0.2,
    });

    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    meshRef.current = cube;

    // 4. 애니메이션 루프 (천천히 회전)
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      if (meshRef.current) {
        meshRef.current.rotation.y += 0.008;
        meshRef.current.rotation.x += 0.003;
      }
      renderer.render(scene, camera);
    };
    animate();

    // 5. 리사이즈 핸들러
    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      renderer.dispose();
    };
  }, []);

  // 스킨 변경 시 텍스처 동적 로드 및 반영
  useEffect(() => {
    if (!meshRef.current || !selectedSkin || !selectedSkin.texturePath) return;

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
      selectedSkin.texturePath,
      (texture) => {
        // 마인크래프트 스타일의 픽셀 아트 텍스처 선명도 유지 (NearestFilter)
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;

        const mat = meshRef.current?.material as THREE.MeshStandardMaterial;
        if (mat) {
          mat.map = texture;
          mat.needsUpdate = true;
        }
      },
      undefined,
      // 텍스처 이미지(png)가 public에 없을 경우 대체 처리
      () => {
        const mat = meshRef.current?.material as THREE.MeshStandardMaterial;
        if (mat) {
          mat.map = null;
          mat.color.setHex(
            selectedSkin.id === "alex"
              ? 0xe07a5f
              : selectedSkin.id === "steve"
              ? 0x3d5a80
              : 0x10b981
          );
          mat.needsUpdate = true;
        }
      }
    );
  }, [selectedSkin]);

  return (
    <div className="w-full h-[350px] bg-slate-900 border border-slate-800 rounded-xl overflow-hidden relative flex items-center justify-center">
      {/* 3D 캔버스 컨테이너 */}
      <div ref={containerRef} className="w-full h-full" />

      {/* 오버레이 라벨 */}
      <div className="absolute top-4 left-4 bg-slate-800/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300">
        미리보기: <span className="font-bold text-emerald-400">{selectedSkin.name}</span>
      </div>
    </div>
  );
}