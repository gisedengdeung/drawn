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

/** 날개 평면 모양. 앞전이 곧고 뒤로 갈수록 좁아지는 직각 사다리꼴이다. */
const WING_SHAPE = '-42,-18 42,-18 42,4 -42,26';

/**
 * 날개 유무를 나타내는 도형.
 *
 * 프로펠러 도형 아이콘에 날개 막대를 덧그렸더니 "있음"과 "없음"이 거의 같아
 * 보였다. 날개만 따로 그리고, 없는 경우는 같은 자리에 ✕ 를 넣어 가른다.
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
    <svg viewBox="-50 -50 100 100" width={size} height={size} className={className} aria-hidden="true">
      <polygon
        points={WING_SHAPE}
        fill={present ? 'currentColor' : 'none'}
        fillOpacity={present ? 0.5 : 0}
        stroke="currentColor"
        strokeWidth={5}
        strokeLinejoin="round"
        opacity={present ? 1 : 0.4}
      />
      {!present && (
        // 날개 모양을 가리지 않도록 가운데 작게. 크게 그으면 사다리꼴이 안 보인다.
        <g stroke="currentColor" strokeWidth={7} strokeLinecap="round">
          <line x1={-10} y1={-7} x2={10} y2={9} />
          <line x1={-10} y1={9} x2={10} y2={-7} />
        </g>
      )}
    </svg>
  );
}
