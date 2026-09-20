export type DroneZone = {
  id: string;
  code: string;
  name: string;
  /** 국토교통부 원본 DMS 좌표를 십진 위경도로 변환한 값입니다. */
  lat: number;
  lng: number;
  radiusKm: number | null;
  ceilingFt: number | null;
  /** 'polygon'이면 lat/lng은 실제 경계가 아니라 꼭짓점들의 중심점 근사치입니다. */
  shape: 'circle' | 'polygon';
  /** shape가 'polygon'일 때만 존재하는 실제 경계 꼭짓점 좌표입니다. */
  vertices?: { lat: number; lng: number }[];
  remark: string | null;
};

export type DroneZoneDataset = {
  source: string;
  sourceUrl: string;
  generatedAt: string;
  /** 실제 CSV의 전체 행 수(시드 데이터의 완성도를 알리기 위한 값이며, 스크립트가 항상 채우지는 않습니다). */
  datasetSize?: number;
  /** true면 scripts/prepare-drone-zones.mjs로 아직 전체 CSV를 반영하지 않은 부분 시드입니다. */
  partial?: boolean;
  zones: DroneZone[];
};

/**
 * 국토교통부_항공레저_초경량비행장치공역(data.go.kr, dataset 15061946) 기반
 * 정적 스냅샷입니다. 연 1회 갱신되는 공식 데이터이며, scripts/prepare-drone-zones.mjs로
 * CSV를 다시 내려받아 재생성할 수 있습니다.
 *
 * 실시간 NOTAM·임시 공역 변경은 반영하지 않으므로, 실제 비행 전에는
 * 드론 원스톱(https://drone.onestop.go.kr)에서 최종 확인이 필요합니다.
 */
export const DRONE_ZONES_URL = '/data/drone-zones.json';

export const DRONE_ONESTOP_URL = 'https://drone.onestop.go.kr';

export function kakaoMapSearchUrl(query: string) {
  return `https://map.kakao.com/link/search/${encodeURIComponent(query)}`;
}

/** Haversine 공식으로 두 좌표 사이의 대권 거리를 km 단위로 계산합니다. */
export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type DroneZoneWithDistance = DroneZone & { distanceKm: number };

export function nearestDroneZones(
  zones: DroneZone[],
  lat: number,
  lng: number,
  limit = 3,
): DroneZoneWithDistance[] {
  return zones
    .map((zone) => ({
      ...zone,
      distanceKm: haversineDistanceKm(lat, lng, zone.lat, zone.lng),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
