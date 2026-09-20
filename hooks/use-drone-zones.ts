import { useEffect, useState } from 'react';

import { DRONE_ZONES_URL, type DroneZoneDataset } from '@/lib/drone-zones';

/** public/data/drone-zones.json을 한 번 불러와 공유하는 훅입니다. */
export function useDroneZones() {
  const [dataset, setDataset] = useState<DroneZoneDataset | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(DRONE_ZONES_URL)
      .then((response) => {
        if (!response.ok) throw new Error('failed');
        return response.json() as Promise<DroneZoneDataset>;
      })
      .then((data) => {
        if (active) setDataset(data);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return { dataset, error };
}
