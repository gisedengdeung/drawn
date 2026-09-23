'use client';

import { useEffect, useState } from 'react';
import type { ShapeClassMap } from '@/lib/design-shape';

/**
 * 설계 27,714개의 생김새 분류를 한 번에 받아둡니다(275KB).
 *
 * 분류는 프로펠러 좌표에서 나오는데 원본 배치 파일은 132MB라 목록 화면에서
 * 받을 수 없어, 설계당 숫자 하나로 줄여둔 것을 읽습니다. 실패해도 목록 자체는
 * 그대로 쓸 수 있어야 하니 오류를 던지지 않고 빈 맵으로 둡니다.
 */
export function useShapeClasses(): { classes: ShapeClassMap; loading: boolean } {
  const [classes, setClasses] = useState<ShapeClassMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch('/data/shape-classes.json')
      .then((response) => {
        if (!response.ok) throw new Error('생김새 분류를 불러오지 못했습니다.');
        return response.json() as Promise<ShapeClassMap>;
      })
      .then((data) => {
        if (active) setClasses(data);
      })
      .catch(() => {
        // 분류가 없어도 번호와 지표로 목록은 쓸 수 있다.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { classes, loading };
}
