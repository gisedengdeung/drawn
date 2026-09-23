'use client';

/**
 * 생김새 분류를 나타내는 도형.
 *
 * 분류 자체가 `방향 수 + 위상`이라 두 숫자로 바로 그릴 수 있습니다. 설계마다
 * 그림을 만들어 두는 것이 아니라 칸마다 하나씩 그리므로, 받아야 할 데이터가
 * 없습니다.
 */
export function ShapeIcon({
  directions,
  aligned = true,
  size = 28,
  className,
}: {
  /** 프로펠러가 향하는 방향의 수. 0이면 방향을 특정하지 않는 칸이다. */
  directions: number;
  /** 기체 축에 맞춰 놓였는지(true), 축 사이로 엇갈렸는지(false). */
  aligned?: boolean;
  size?: number;
  className?: string;
}) {
  const count = Math.max(0, Math.min(directions, 16));
  // 위상은 0° 아니면 간격의 절반, 두 값에만 몰린다. 그대로 그림에 옮긴다.
  const step = count > 0 ? 360 / count : 0;
  const phase = aligned ? 0 : step / 2;
  const reach = 34;
  const rotor = count >= 9 ? 6 : count >= 7 ? 7 : 9;

  const spokes = Array.from({ length: count }, (_, index) => {
    const angle = ((phase + index * step) * Math.PI) / 180;
    // 화면 y는 아래로 자라므로 세로만 뒤집는다.
    return { x: Math.cos(angle) * reach, y: -Math.sin(angle) * reach };
  });

  return (
    <svg viewBox="-50 -50 100 100" width={size} height={size} className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth={5} opacity={0.4} strokeLinecap="round">
        {spokes.map((spoke, index) => (
          <line key={`arm-${index}`} x1={0} y1={0} x2={spoke.x} y2={spoke.y} />
        ))}
      </g>
      <circle cx={0} cy={0} r={11} fill="currentColor" opacity={0.55} />
      <g fill="none" stroke="currentColor" strokeWidth={5}>
        {spokes.map((spoke, index) => (
          <circle key={`rotor-${index}`} cx={spoke.x} cy={spoke.y} r={rotor} />
        ))}
      </g>
    </svg>
  );
}

/**
 * 날개 유무를 나타내는 도형.
 *
 * 사용자가 제공한 `wing_icon_no_x.svg`, `wing_icon_with_x.svg`의 벡터를 사용한다.
 * 카드의 선택 색을 그대로 받을 수 있도록 원본의 고정 회색은 currentColor로 바꿨다.
 */
export function WingIcon({
  present,
  size = 28,
  className,
}: {
  present: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg viewBox="0 0 512 512" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M 140 170 Q 95 172 95 215 L 95 325 Q 95 365 135 368 Q 265 370 350 354 Q 410 342 450 285 L 478 225 Q 498 180 452 176 Q 300 182 140 170 Z"
        fill="currentColor"
        fillOpacity={present ? 0.18 : 0.08}
        stroke="currentColor"
        strokeWidth={18}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={present ? 0.95 : 0.68}
      />
      {!present && (
        <g stroke="currentColor" strokeWidth={20} strokeLinecap="round" opacity={0.9}>
          <line x1={259} y1={241} x2={317} y2={299} />
          <line x1={317} y1={241} x2={259} y2={299} />
        </g>
      )}
    </svg>
  );
}
