'use client';

/* oxlint-disable next/no-html-link-for-pages -- Standard anchors avoid Vinext's production Link module export bug. */

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Info, Loader2, Navigation } from 'lucide-react';

import { DroneZonesMap } from '@/components/drone-zones-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDroneZones } from '@/hooks/use-drone-zones';
import { useGeolocation } from '@/hooks/use-geolocation';
import {
  DRONE_ONESTOP_URL,
  haversineDistanceKm,
  kakaoMapSearchUrl,
  type DroneZone,
} from '@/lib/drone-zones';

const EMPTY_ZONES: DroneZone[] = [];

export function FlightMapPage() {
  const { dataset, error: datasetError } = useDroneZones();
  const { status, position, locate } = useGeolocation();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 위젯 등에서 /flight-map?zone=<id>로 들어오면 해당 공역을 바로 선택합니다.
  useEffect(() => {
    window.queueMicrotask(() => {
      const zoneParam = new URLSearchParams(window.location.search).get('zone');
      if (zoneParam) setSelectedId(zoneParam);
    });
  }, []);

  const zones = dataset?.zones ?? EMPTY_ZONES;
  const sortedZones = useMemo(() => {
    if (!position) return zones;
    return [...zones].sort(
      (a, b) =>
        haversineDistanceKm(position.lat, position.lng, a.lat, a.lng) -
        haversineDistanceKm(position.lat, position.lng, b.lat, b.lng),
    );
  }, [zones, position]);

  return (
    <main className="workspace-light min-h-screen bg-[#f5f5f7] text-[#1d1d1f]">
      <header className="sticky top-0 z-40 border-b border-[#e5e5ea] bg-white/95 px-4 py-3 backdrop-blur-xl lg:px-6">
        <div className="mx-auto flex max-w-[1720px] flex-wrap items-center justify-between gap-3">
          <div>
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#6e6e73] hover:text-[#3c3c43]"
            >
              <ArrowLeft className="size-3.5" /> 워크벤치로 돌아가기
            </a>
            <h1 className="mt-1.5 text-lg font-semibold text-[#1d1d1f]">
              드론 비행 공역 지도
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="border-[#bfdbfe] bg-[#eff6ff] text-[10px] text-[#1b64da]"
            >
              국토부 UL 공역 전체 {zones.length || 34}곳
            </Badge>
            <Button
              onClick={locate}
              size="sm"
              disabled={!dataset || status === 'loading'}
              className="bg-[#3182f6] text-white hover:bg-[#1b64da]"
            >
              {status === 'loading' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Navigation className="size-3.5" />
              )}
              내 위치 찾기
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1720px] px-4 py-4 lg:px-6">
        {datasetError && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            공역 데이터를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.
          </div>
        )}
        {(status === 'denied' || status === 'error' || status === 'unsupported') && (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {status === 'denied'
              ? '위치 권한이 거부되었습니다. 브라우저 위치 권한을 허용한 뒤 다시 시도하세요.'
              : status === 'unsupported'
                ? '이 브라우저는 위치 확인을 지원하지 않습니다.'
                : '위치를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <DroneZonesMap
            zones={zones}
            userPosition={position}
            selectedId={selectedId}
            onSelect={setSelectedId}
            className="h-[calc(100vh-190px)] min-h-[420px] overflow-hidden rounded-2xl border border-[#e5e5ea] shadow-sm"
          />

          <aside className="workspace-panel flex h-[calc(100vh-190px)] min-h-[420px] flex-col overflow-hidden rounded-2xl">
            <div className="border-b border-[#e5e5ea] p-3.5">
              <p className="text-xs font-medium text-[#3c3c43]">
                {position ? '가까운 순 정렬' : '전체 목록 (위치 미확인)'}
              </p>
              <p className="mt-1 text-[10px] leading-4 text-[#86868b]">
                연 1회 갱신되는 국토부 스냅샷입니다. 실시간 공역 변경은 반영하지
                않으니 비행 전 드론 원스톱에서 최종 확인하세요.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {sortedZones.map((zone, index) => {
                const distanceKm = position
                  ? haversineDistanceKm(position.lat, position.lng, zone.lat, zone.lng)
                  : null;
                const isSelected = zone.id === selectedId;
                return (
                  <button
                    key={zone.id}
                    onClick={() => setSelectedId(zone.id)}
                    className={`mb-1 w-full rounded-xl border p-3 text-left transition ${
                      isSelected
                        ? 'border-[#93c5fd] bg-[#eff6ff] shadow-sm'
                        : 'border-transparent hover:border-[#e5e5ea] hover:bg-[#f5f5f7]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-[#3c3c43]">
                          {position && index < 3 && (
                            <span className="mr-1 rounded bg-[#3182f6] px-1 py-0.5 text-[9px] font-semibold text-white">
                              {index + 1}
                            </span>
                          )}
                          {zone.name}{' '}
                          <span className="font-mono text-[10px] text-[#86868b]">{zone.code}</span>
                        </p>
                        <p className="mt-1 truncate text-[10px] text-[#86868b]">
                          {zone.shape === 'polygon'
                            ? '다각형 구역'
                            : zone.radiusKm != null
                              ? `반경 ${zone.radiusKm}km`
                              : '반경 정보 없음'}
                          {zone.ceilingFt != null ? ` · ${zone.ceilingFt}ft AGL` : ''}
                        </p>
                      </div>
                      {distanceKm != null && (
                        <span className="shrink-0 font-mono text-[11px] font-semibold text-[#1b64da]">
                          {distanceKm.toFixed(0)}km
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              {sortedZones.length === 0 && !datasetError && (
                <div className="grid h-full place-items-center p-6 text-center text-xs text-[#6e6e73]">
                  <Loader2 className="mx-auto mb-2 size-4 animate-spin" /> 공역 데이터
                  불러오는 중…
                </div>
              )}
            </div>
            <div className="border-t border-[#e5e5ea] p-3 space-y-2">
              {selectedId && (
                <a
                  href={kakaoMapSearchUrl(
                    zones.find((zone) => zone.id === selectedId)?.name ?? '',
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-[#e5e5ea] bg-white px-2.5 py-2 text-[10px] text-[#6e6e73] hover:bg-[#f5f5f7]"
                >
                  카카오맵에서 보기 <ExternalLink className="ml-auto size-3 shrink-0" />
                </a>
              )}
              <a
                href={DRONE_ONESTOP_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-dashed border-[#e5e5ea] px-2.5 py-2 text-[10px] text-[#6e6e73] hover:bg-[#f5f5f7]"
              >
                <Info className="size-3 shrink-0" /> 드론 원스톱에서 최종 확인
                <ExternalLink className="ml-auto size-3 shrink-0" />
              </a>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
