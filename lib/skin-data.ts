export interface DroneSkin {
  id: string;
  name: string;
  color: string; // 3D 모델에 적용되는 Hex 컬러값
  texturePath?: string;
  thumbnailPath?: string; 
  description?: string;
}

export const DRONE_SKINS: DroneSkin[] = [
  {
    id: 'default',
    name: '흰색', 
    color: '#ffffff',   // 흰색으로 변경
  },
  {
    id: 'black',
    name: '검정',       // 'alex' -> '검정'
    color: '#1a1a1a',   // 검정색 계열 Hex
  },
  {
    id: 'gray',
    name: '회색',       // 'steve' -> '회색'
    color: '#808080',   // 회색 계열 Hex
  },
  // 필요에 따라 추가 색상 배치
];