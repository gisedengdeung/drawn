import type { DesignSummary } from '@/lib/drawn-types';

// The FastAPI backend (see backend/README.md) isn't deployed anywhere yet —
// this only resolves when `uvicorn app.main:app --port 8000` is running
// locally alongside the dev server.
const BACKEND_URL = 'http://localhost:8000';

export type TrimPrediction = {
  drag: number;
  lift: number;
  thrust: number;
  pitch: number;
  power: number;
  current: number;
  flightTime: number;
  distance: number;
  modelVersion: string;
  isMock: boolean;
};

export async function predictTrim(
  design: DesignSummary,
  speed: number,
  signal?: AbortSignal,
): Promise<TrimPrediction> {
  const response = await fetch(`${BACKEND_URL}/predict/trim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      design_id: design.id,
      speed,
      numPropellers: design.numPropellers,
      numWings: design.numWings,
      armLength: design.armLength,
      meanArmLength: design.meanArmLength,
      maxArmLength: design.maxArmLength,
      fuselageLength: design.fuselageLength,
      fuselageHorizontalDiameter: design.fuselageHorizontalDiameter,
      fuselageVerticalDiameter: design.fuselageVerticalDiameter,
      totalWingSpan: design.totalWingSpan,
      meanWingChord: design.meanWingChord,
      parameterCount: design.parameterCount,
      hub: design.hub,
      primaryMotor: design.primaryMotor,
      primaryPropeller: design.primaryPropeller,
      primaryBattery: design.primaryBattery,
      dragAt20: design.dragAt20,
      powerAt20: design.powerAt20,
      powerAt0: design.powerAt0,
      thrustAt0: design.thrustAt0,
      currentAt0: design.currentAt0,
    }),
  });
  if (!response.ok) {
    throw new Error(`trim 예측 요청 실패 (HTTP ${response.status})`);
  }
  const data = (await response.json()) as {
    drag: number;
    lift: number;
    thrust: number;
    pitch: number;
    power: number;
    current: number;
    flightTime: number;
    distance: number;
    model_version: string;
    is_mock: boolean;
  };
  return {
    drag: data.drag,
    lift: data.lift,
    thrust: data.thrust,
    pitch: data.pitch,
    power: data.power,
    current: data.current,
    flightTime: data.flightTime,
    distance: data.distance,
    modelVersion: data.model_version,
    isMock: data.is_mock,
  };
}
