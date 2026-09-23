export type ViewerCameraPose = {
  /** 카메라와 주시점 사이 벡터를 모델 반지름으로 정규화한 값. */
  offset: [number, number, number];
  /** 최초 프레이밍 중심에서 이동한 주시점 거리. */
  targetOffset: [number, number, number];
  zoom: number;
};

type CameraEndpoint = {
  read: () => ViewerCameraPose | null;
  apply: (pose: ViewerCameraPose) => void;
};

const groups = new Map<string, Map<string, CameraEndpoint>>();

export function registerViewerCamera(group: string, id: string, endpoint: CameraEndpoint) {
  const members = groups.get(group) ?? new Map<string, CameraEndpoint>();
  members.set(id, endpoint);
  groups.set(group, members);
  return () => {
    const current = groups.get(group);
    current?.delete(id);
    if (!current?.size) groups.delete(group);
  };
}

export function broadcastViewerCamera(group: string, sourceId: string) {
  const members = groups.get(group);
  const pose = members?.get(sourceId)?.read();
  if (!members || !pose) return false;
  for (const [id, endpoint] of members) {
    if (id !== sourceId) endpoint.apply(pose);
  }
  return true;
}

export function copyViewerCamera(group: string, sourceId: string, targetId: string) {
  const members = groups.get(group);
  const pose = members?.get(sourceId)?.read();
  const target = members?.get(targetId);
  if (!pose || !target) return false;
  target.apply(pose);
  return true;
}
