'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ExternalLink, Info, Loader2, Map, MapPin, Navigation } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDroneZones } from '@/hooks/use-drone-zones';
import { useGeolocation } from '@/hooks/use-geolocation';
import { DRONE_ONESTOP_URL, nearestDroneZones } from '@/lib/drone-zones';

export function NearbyFlightSites() {
  const { dataset, error: datasetError } = useDroneZones();
  const { status, position, locate } = useGeolocation();

  const zones = useMemo(() => {
    if (status !== 'ready' || !position || !dataset) return [];
    return nearestDroneZones(dataset.zones, position.lat, position.lng, 3);
  }, [status, position, dataset]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-[#294353]">
          <MapPin className="size-3.5 text-[#147d91]" /> 내 주변 비행 장소
        </h3>
        <Badge
          variant="outline"
          className="border-[#b8dfe4] bg-[#eef8fa] text-[9px] tracking-[0.06em] text-[#0f6475]"
        >
          국토부 UL 공역
        </Badge>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-[#82919c]">
        국토교통부 초경량비행장치 비행공역(UA) 전체 {dataset?.zones.length ?? 34}곳
        공식 데이터로 가까운 곳을 안내합니다. 연 1회 갱신되는 스냅샷이라 실시간
        공역 변경은 반영하지 않습니다.
      </p>

      {datasetError && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] leading-5 text-amber-900">
          공역 데이터를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.
        </p>
      )}

      {!datasetError && status === 'idle' && (
        <Button
          onClick={locate}
          size="sm"
          disabled={!dataset}
          className="mt-3 w-full bg-[#147d91] text-white hover:bg-[#0f6878]"
        >
          <Navigation className="size-3.5" /> 내 위치에서 가까운 순으로 찾기
        </Button>
      )}

      {status === 'loading' && (
        <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-[#dbe4ea] bg-[#f7f9fb] py-4 text-xs text-[#607383]">
          <Loader2 className="size-3.5 animate-spin" /> 위치 확인 중…
        </div>
      )}

      {(status === 'denied' || status === 'error' || status === 'unsupported') && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">
          {status === 'denied'
            ? '위치 권한이 거부되어 거리순으로 안내할 수 없습니다. 브라우저 위치 권한을 허용한 뒤 다시 시도하세요.'
            : status === 'unsupported'
              ? '이 브라우저는 위치 확인을 지원하지 않습니다.'
              : '위치를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'}
          <Button
            onClick={locate}
            size="sm"
            variant="outline"
            className="mt-2 w-full border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
          >
            다시 시도
          </Button>
        </div>
      )}

      {status === 'ready' && (
        <div className="mt-3 space-y-2">
          {zones.map((zone) => (
            <Link
              key={zone.id}
              href={`/flight-map?zone=${zone.id}`}
              aria-label={`${zone.name} 지도에서 보기 (약 ${zone.distanceKm.toFixed(0)}km)`}
              className="block rounded-lg border border-[#dbe4ea] bg-[#f7f9fb] p-2.5 transition hover:border-[#9ccdd6] hover:bg-[#eef8fa]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-[#294353]">
                    {zone.name} <span className="font-mono text-[10px] text-[#9aabb5]">{zone.code}</span>
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-[#82919c]">
                    {zone.shape === 'polygon'
                      ? '다각형 구역 · 중심점 근사'
                      : zone.radiusKm != null
                        ? `반경 ${zone.radiusKm}km`
                        : '반경 정보 없음'}
                    {zone.ceilingFt != null ? ` · 고도 ${zone.ceilingFt}ft AGL` : ''}
                  </p>
                  {zone.remark && (
                    <p className="mt-0.5 truncate text-[10px] text-[#9aabb5]">{zone.remark}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-semibold text-[#0f6475]">
                  약 {zone.distanceKm.toFixed(0)}km
                  <Map className="size-3 text-[#9aabb5]" />
                </div>
              </div>
            </Link>
          ))}
          <Link
            href="/flight-map"
            className="mt-1 flex items-center gap-1.5 rounded-lg border border-[#b8dfe4] bg-[#eef8fa] px-2.5 py-2 text-[10px] font-medium text-[#0f6475] hover:bg-[#e0f1f4]"
          >
            <Map className="size-3 shrink-0" /> 지도에서 전체 34곳 크게 보기
          </Link>
          <a
            href={DRONE_ONESTOP_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#cfdbe2] px-2.5 py-2 text-[10px] text-[#607383] hover:bg-[#f4f7f9]"
          >
            <Info className="size-3 shrink-0" /> 비행 승인·최신 공역 정보는 드론
            원스톱에서 최종 확인하세요
            <ExternalLink className="ml-auto size-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  );
}
