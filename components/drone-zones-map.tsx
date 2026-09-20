'use client';

import { useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { DroneZone } from '@/lib/drone-zones';
import type { LatLng } from '@/hooks/use-geolocation';

const KOREA_CENTER: L.LatLngTuple = [36.4, 127.9];
const ZONE_COLOR = '#147d91';
const NEAREST_COLOR = '#6750a4';

type DroneZonesMapProps = {
  zones: DroneZone[];
  userPosition: LatLng | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
};

export function DroneZonesMap({
  zones,
  userPosition,
  selectedId,
  onSelect,
  className = '',
}: DroneZonesMapProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const layersRef = useRef(new Map<string, L.Layer>());
  const userMarkerRef = useRef<L.CircleMarker | null>(null);
  const onSelectRef = useRef(onSelect);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // leaflet은 window/document를 참조하므로 클라이언트에서만 동적으로 불러옵니다(SSR 시 로드 시 에러 발생).
  useEffect(() => {
    let cancelled = false;
    const layers = layersRef.current;
    let map: L.Map | null = null;

    void import('leaflet').then((mod) => {
      if (cancelled || !mountRef.current) return;
      const leaflet = mod.default;
      leafletRef.current = leaflet;
      map = leaflet.map(mountRef.current, {
        center: KOREA_CENTER,
        zoom: 7,
        scrollWheelZoom: true,
      });
      leaflet
        .tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19,
        })
        .addTo(map);
      mapRef.current = map;
      setReady(true);
    });

    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      layers.clear();
      userMarkerRef.current = null;
    };
  }, []);

  // 공역 도형은 지도가 준비되었거나 zones가 바뀔 때 다시 그립니다.
  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!ready || !map || !leaflet) return;

    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current.clear();

    for (const zone of zones) {
      const shape: L.Path =
        zone.shape === 'polygon' && zone.vertices
          ? leaflet.polygon(
              zone.vertices.map((vertex): L.LatLngTuple => [vertex.lat, vertex.lng]),
              { color: ZONE_COLOR, weight: 2, fillOpacity: 0.18 },
            )
          : leaflet.circle([zone.lat, zone.lng], {
              radius: (zone.radiusKm ?? 0.3) * 1000,
              color: ZONE_COLOR,
              weight: 2,
              fillOpacity: 0.18,
            });

      shape.bindPopup(
        `<strong>${zone.name}</strong> <span style="color:#9aabb5">${zone.code}</span><br/>` +
          `${zone.shape === 'polygon' ? '다각형 구역' : `반경 ${zone.radiusKm ?? '—'}km`}` +
          `${zone.ceilingFt != null ? ` · 고도 ${zone.ceilingFt}ft AGL` : ''}` +
          `${zone.remark ? `<br/><span style="color:#82919c">${zone.remark}</span>` : ''}`,
      );
      shape.on('click', () => onSelectRef.current(zone.id));
      shape.addTo(map);
      layersRef.current.set(zone.id, shape);
    }

    if (zones.length > 0 && !userPosition) {
      const bounds = leaflet.latLngBounds(zones.map((zone): L.LatLngTuple => [zone.lat, zone.lng]));
      map.fitBounds(bounds, { padding: [24, 24] });
    }
  }, [ready, zones, userPosition]);

  // 선택된 공역을 하이라이트합니다.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    layersRef.current.forEach((layer, id) => {
      if ('setStyle' in layer) {
        (layer as L.Path).setStyle({ color: id === selectedId ? NEAREST_COLOR : ZONE_COLOR, weight: id === selectedId ? 3 : 2 });
      }
    });
    if (selectedId) {
      const layer = layersRef.current.get(selectedId) as L.Circle | L.Polygon | undefined;
      if (layer) {
        map.flyToBounds(layer.getBounds(), { padding: [80, 80], maxZoom: 12, duration: 0.6 });
        layer.openPopup();
      }
    }
  }, [ready, selectedId]);

  // 사용자 위치 마커는 위치가 갱신될 때만 반영합니다.
  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!ready || !map || !leaflet) return;
    if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
    if (!userPosition) return;
    const marker = leaflet
      .circleMarker([userPosition.lat, userPosition.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: '#e0575b',
        fillOpacity: 1,
      })
      .bindPopup('내 위치');
    marker.addTo(map);
    userMarkerRef.current = marker;
    map.flyTo([userPosition.lat, userPosition.lng], 9, { duration: 0.6 });
  }, [ready, userPosition]);

  return <div ref={mountRef} role="application" aria-label="드론 비행 공역 지도" className={className} />;
}
