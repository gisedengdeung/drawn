import { useState } from 'react';

export type GeolocationStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'denied'
  | 'error'
  | 'unsupported';

export type LatLng = { lat: number; lng: number };

/** navigator.geolocation을 감싼 공용 훅입니다. 위젯과 전체 화면 지도 페이지가 함께 씁니다. */
export function useGeolocation() {
  const [status, setStatus] = useState<GeolocationStatus>('idle');
  const [position, setPosition] = useState<LatLng | null>(null);

  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    navigator.geolocation.getCurrentPosition(
      (result) => {
        setPosition({ lat: result.coords.latitude, lng: result.coords.longitude });
        setStatus('ready');
      },
      (geoError) => {
        setStatus(geoError.code === geoError.PERMISSION_DENIED ? 'denied' : 'error');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  };

  return { status, position, locate };
}
