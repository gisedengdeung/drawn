import * as THREE from 'three';

type ComponentMeshRecord = {
  file: string;
  type: string;
  sourceDesignId: number;
  sourcePart: string;
  vertexCount: number;
  triangleCount: number;
};

type ComponentMeshIndex = {
  version: 5;
  models: Record<string, ComponentMeshRecord>;
};

const MAGIC = 'DCM1';
const geometryCache = new Map<string, THREE.BufferGeometry>();
const loading = new Map<string, Promise<boolean>>();
let indexRequest: Promise<ComponentMeshIndex | null> | null = null;

/** 카탈로그 모델별 표준 메시를 찾는다. 크기는 배치 시 균일하게 맞춘다. */
export function componentMeshKey(
  model: string | undefined,
  _size?: readonly number[],
) {
  return model;
}

/** 원본 STEP에서 설계·인스턴스 단위로 직접 뽑은 예외 메시 키. */
export function componentInstanceMeshKey(designId: number, partName: string) {
  return `design:${designId}:part:${partName}`;
}

function readIndex() {
  indexRequest ??= fetch('/data/component-meshes/index.json?v=5', {
    cache: 'no-cache',
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((value) => {
      if ((value as { version?: unknown } | null)?.version === 5) {
        return value as ComponentMeshIndex;
      }
      // 자산 생성 도중 이전 인덱스를 읽었으면 다음 요청에서 다시 시도한다.
      indexRequest = null;
      return null;
    })
    .catch(() => {
      indexRequest = null;
      return null;
    });
  return indexRequest;
}

/** 필요한 고정 부품 메시만 지연 로드한다. 실패하면 기존 절차형 형상을 유지한다. */
export async function loadComponentMeshes(models: string[]) {
  const index = await readIndex();
  if (!index) return 0;
  const unique = [...new Set(models)];
  let loaded = 0;
  await Promise.all(
    unique.map(async (model) => {
      if (geometryCache.has(model)) return;
      const record = index.models[model];
      if (!record) return;
      let request = loading.get(model);
      if (!request) {
        request = fetch(`/data/component-meshes/${record.file}`)
          .then(async (response) => {
            if (!response.ok) return false;
            registerComponentMesh(model, await response.arrayBuffer());
            return true;
          })
          .catch(() => false);
        loading.set(model, request);
      }
      if (await request) loaded += 1;
    }),
  );
  return loaded;
}

/** 캐시 원본은 공유하지 않고 clone하여 뷰어 dispose와 분리한다. */
export function componentGeometry(model: string | undefined) {
  return model ? (geometryCache.get(model)?.clone() ?? null) : null;
}

/** 브라우저 로더와 Node 감사 도구가 같은 바이너리 해석기를 사용한다. */
export function registerComponentMesh(
  model: string,
  input: ArrayBuffer | Uint8Array,
) {
  const bytes =
    input instanceof Uint8Array
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`Invalid component mesh: ${model}`);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const positionsAt = 16;
  const normalsAt = positionsAt + vertexCount * 3 * 4;
  const indicesAt = normalsAt + vertexCount * 3 * 4;
  const expected = indicesAt + indexCount * 4;
  if (expected !== bytes.byteLength) {
    throw new Error(`Invalid component mesh length: ${model}`);
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  for (let index = 0; index < positions.length; index += 1) {
    positions[index] = view.getFloat32(positionsAt + index * 4, true);
    normals[index] = view.getFloat32(normalsAt + index * 4, true);
  }
  for (let index = 0; index < indices.length; index += 1) {
    indices[index] = view.getUint32(indicesAt + index * 4, true);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometryCache.get(model)?.dispose();
  geometryCache.set(model, geometry);
}
