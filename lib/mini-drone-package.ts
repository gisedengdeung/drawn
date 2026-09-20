export const miniDronePackage = {
  id: 'mini',
  name: '처음 만나는 미니 드론 패키지',
  purpose: '입문·취미',
  description: '조종이 처음이라도, 가볍게 시작해요.',
  price: 59000,
  original: 79000,
  color: '#ef875a',
  tag: '입문 추천',
  image: '/images/packages/mini-drone.png',
  items: ['미니 드론', '조종기', '배터리 2개', '프로펠러 가드', '시작 가이드'],
};

export const packageWon = (value: number) => `${value.toLocaleString('ko-KR')}원`;
