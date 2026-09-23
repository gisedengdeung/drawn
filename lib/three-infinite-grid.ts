import * as THREE from 'three';

export type InfiniteGrid = {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  step: number;
  fadeDistance: number;
  y: number;
};

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vWorldPosition;
  uniform float uMinorStep;
  uniform float uMajorStep;
  uniform float uFadeDistance;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec3 uAxisColor;

  float gridLine(vec2 coordinate, float stepSize) {
    vec2 scaled = coordinate / stepSize;
    vec2 width = max(fwidth(scaled), vec2(0.0001));
    vec2 distanceToLine = abs(fract(scaled - 0.5) - 0.5) / width;
    return 1.0 - min(min(distanceToLine.x, distanceToLine.y), 1.0);
  }

  void main() {
    float minor = gridLine(vWorldPosition.xz, uMinorStep);
    float major = gridLine(vWorldPosition.xz, uMajorStep);
    float distanceFromCamera = length(vWorldPosition.xz - cameraPosition.xz);
    float fade = 1.0 - smoothstep(uFadeDistance * 0.28, uFadeDistance, distanceFromCamera);

    float axisWidthX = max(fwidth(vWorldPosition.x), 0.0001) * 1.35;
    float axisWidthZ = max(fwidth(vWorldPosition.z), 0.0001) * 1.35;
    float axis = max(
      1.0 - smoothstep(0.0, axisWidthX, abs(vWorldPosition.x)),
      1.0 - smoothstep(0.0, axisWidthZ, abs(vWorldPosition.z))
    );

    vec3 color = mix(uMinorColor, uMajorColor, major);
    color = mix(color, uAxisColor, axis);
    float opacity = max(minor * 0.34, major * 0.62);
    opacity = max(opacity, axis * 0.72) * fade;
    if (opacity < 0.01) discard;
    gl_FragColor = vec4(color, opacity);
  }
`;

export function createInfiniteGrid(y = -0.9): InfiniteGrid {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uMinorStep: { value: 1 },
      uMajorStep: { value: 5 },
      uFadeDistance: { value: 60 },
      uMinorColor: { value: new THREE.Color(0xd4e0e5) },
      uMajorColor: { value: new THREE.Color(0x9cb3bd) },
      uAxisColor: { value: new THREE.Color(0x7f9eaa) },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  const grid = { mesh, step: 1, fadeDistance: 60, y };
  configureInfiniteGrid(grid, { step: 1, fadeDistance: 60, y });
  return grid;
}

export function configureInfiniteGrid(
  grid: InfiniteGrid,
  options: { step: number; fadeDistance: number; y?: number },
) {
  grid.step = Math.max(options.step, 0.01);
  grid.fadeDistance = Math.max(options.fadeDistance, grid.step * 8);
  grid.y = options.y ?? grid.y;
  grid.mesh.material.uniforms.uMinorStep.value = grid.step;
  grid.mesh.material.uniforms.uMajorStep.value = grid.step * 5;
  grid.mesh.material.uniforms.uFadeDistance.value = grid.fadeDistance;
  grid.mesh.scale.set(grid.fadeDistance, grid.fadeDistance, 1);
}

export function updateInfiniteGrid(grid: InfiniteGrid, camera: THREE.Camera) {
  // 격자 한 칸 단위로만 이동시켜 카메라 이동 중 선이 미세하게 흔들리지 않게 한다.
  grid.mesh.position.set(
    Math.round(camera.position.x / grid.step) * grid.step,
    grid.y,
    Math.round(camera.position.z / grid.step) * grid.step,
  );
}

export function disposeInfiniteGrid(grid: InfiniteGrid) {
  grid.mesh.geometry.dispose();
  grid.mesh.material.dispose();
}
