'use client';

import {
  Activity,
  ArrowLeft,
  Beaker,
  Boxes,
  CircleGauge,
  Gauge,
  Image as ImageIcon,
  Layers3,
  Route,
  Share2,
  Sparkles,
  Target,
  Weight,
  Wind,
  Zap,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/views/shared';

function MediaPlaceholder({ label, className = '' }: { label: string; className?: string }) {
  return (
    <div className={`flex aspect-video items-center justify-center rounded-lg border border-dashed border-[#c7d3d9] bg-[#f5f5f7] text-center ${className}`}>
      <div>
        <ImageIcon className="mx-auto size-5 text-[#a7b6bd]" />
        <p className="mt-1.5 max-w-40 text-[10px] leading-4 text-[#86868b]">{label}</p>
      </div>
    </div>
  );
}

const FORCES = [
  { label: '추력', desc: '프로펠러가 공기를 밀어내며 생기는, 위로(또는 앞으로) 미는 힘.' },
  { label: '중력', desc: '기체 무게가 땅으로 끌어당겨지는 힘. 추력이 이걸 이겨야 뜹니다.' },
  { label: '항력', desc: '비행 중 공기가 기체를 뒤로 미는 저항력.' },
  { label: '양력', desc: '날개 위아래 공기 흐름 차이로 추가로 뜨는 힘 (날개가 있을 때).' },
];

const PARTS = [
  {
    label: '허브 (Hub)',
    desc: '몸통 중심. 팔이 많이 붙을수록(4→6→8개) 구조가 튼튼해지고 모터 하나가 고장 나도 버틸 수 있지만, 부품이 늘어난 만큼 무게와 소비전력이 늘어 비행거리·체공시간은 줄어드는 경향이 있어요 (옥토콥터가 헥사콥터보다 무겁고 비효율적으로 나온 이유이기도 해요).',
  },
  {
    label: '팔 (Arm)',
    desc: '허브에서 프로펠러까지의 길이. 길면 프로펠러끼리 멀어져 회전할 때 서로 공기 흐름을 방해하는 간섭이 줄어 더 안정적으로 날지만, 무게가 늘고 바람 저항(항력)을 더 받아 속도·비행거리엔 불리해질 수 있어요.',
  },
  {
    label: '모터 (Motor)',
    desc: '크고 강력할수록 더 큰 추력을 낼 수 있어 무거운 짐을 들거나 빠르게 날 수 있지만, 모터 자체 무게와 소비전력이 커져 배터리가 더 빨리 닳아요. 작은 모터는 가볍고 전력을 아끼지만 최대 추력이 작아 무거운 설계엔 못 씁니다.',
  },
  {
    label: '프로펠러 (Propeller)',
    desc: '지름이 크면 한 번 돌 때 더 많은 공기를 밀어내 추력이 커지지만, 돌릴 때 저항도 커져 더 강한 모터와 전력이 필요해요. 작은 프로펠러는 반응(민첩성)은 빠르지만 추력이 작아 무거운 기체를 못 띄워요.',
  },
  {
    label: '배터리 (Battery)',
    desc: '용량이 크면 더 오래·멀리 날 수 있지만, 배터리 자체가 무거워서 어느 지점을 넘으면 "더 태우려고 실은 무게 때문에 추력이 더 필요해지는" 역효과가 나서 비행시간이 무한정 늘지는 않아요.',
  },
  {
    label: '날개 (Wing)',
    desc: '있으면 프로펠러 힘 없이도 공기 흐름만으로 양력을 얻어 같은 배터리로 훨씬 멀리·오래 날 수 있지만(고정익이 장거리에 유리하다는 이유), 제자리 비행(호버링)이 어렵고 이착륙에 활주로·발사대가 필요해요.',
  },
];

const AIRFRAME_STATS = [
  { label: '헥사콥터', successRate: '59.4%', mass: '6.2kg', distance: '4.06km', hover: '181초', power: '1,842W', pareto: '22%' },
  { label: '쿼드콥터', successRate: '34.2%', mass: '4.3kg', distance: '2.87km', hover: '114초', power: '1,166W', pareto: '66%' },
  { label: '옥토콥터', successRate: '37.2%', mass: '6.3kg', distance: '2.14km', hover: '68초', power: '2,178W', pareto: '3%' },
  { label: '고정익·복합익', successRate: '26.2%', mass: '7.0kg', distance: '1.81km', hover: '42초', power: '1,782W', pareto: '9%' },
  { label: '멀티콥터(기타)', successRate: '24.5%', mass: '7.6kg', distance: '1.78km', hover: '51초', power: '2,838W', pareto: '0%' },
];

const PURPOSE_CLUSTERS = [
  { label: 'A · 경량형', share: '38.0%', desc: '가장 가볍고(4.2kg) 전력도 가장 적게(945W) 씁니다. 짧고 가벼운 임무에 맞아요.' },
  { label: 'B · 고속형', share: '31.4%', desc: '무게는 준수한데 최고속도 32.3m/s로 전체 중 가장 빠릅니다. 빠른 이동이 중요한 임무에 적합해요.' },
  { label: 'C · 저효율형', share: '15.5%', desc: '무겁고(8.5kg) 느린데(14.1m/s) 전력만 많이 씁니다(2,656W). 좋게 포장하기 어려운, 비효율적인 설계군이에요.' },
  { label: 'D · 장거리·정찰형', share: '10.1%', desc: '비행거리 10.9km, 체공시간 512초(8.5분)로 다른 그룹보다 압도적으로 깁니다. 오래 멀리 가야 하는 임무에 맞아요.' },
  { label: 'E · 고중량·고성능형', share: '5.0%', desc: '가장 무겁지만(12.7kg) 속도(33.6m/s)·거리(5.8km)도 희생하지 않습니다. 대신 전력을 압도적으로 많이 씁니다(5,710W).' },
];

const WORKFLOW_STEPS = [
  { icon: Boxes, label: '1. 설계 선택', desc: '27,714개 중 마음에 드는 기체를 고릅니다. 조건에 맞는 후보를 찾고, 두 설계의 구성과 성능도 비교할 수 있어요.' },
  { icon: Beaker, label: '2. 파라미터 편집', desc: '팔 길이, 날개 크기 같은 치수를 직접 조정합니다. 성능 변화는 추정치로 함께 보여줘요.' },
  { icon: Activity, label: '3. 성능 확인', desc: '속도를 0~50m/s 사이에서 움직이며 항력·전력이 어떻게 변하는지 봅니다. 정밀 3D 12개에서만 가능해요.' },
  { icon: Share2, label: '4. 공유 갤러리', desc: '완성한 설계를 게시하고, 다른 사람의 설계를 가져와 이어서 편집할 수 있어요.' },
] as const;

const GLOSSARY = [
  { term: '소비전력', def: '비행 중 순간적으로 쓰는 전력(와트). 클수록 배터리가 빨리 닳습니다.' },
  { term: '항력', def: '비행 중 공기가 기체를 뒤로 미는 저항력. 클수록 더 많은 힘이 필요해요.' },
  { term: '유효 비행성능', def: '물리 계산상 실제로 날 수 있다고 확인된 설계라는 뜻. 일부 설계는 계산이 안 맞아 성능값 자체가 없어요.' },
  { term: '기준(Baseline)', def: '지금 편집 중인 설계의 원래(수정 전) 상태. 편집 화면에서 늘 비교 대상이 됩니다.' },
];

export function GuideView({ onBack }: { onBack: () => void }) {
  return (
    <section className="px-4 py-4 lg:px-6">
      <SectionHeading
        eyebrow="이용 가이드"
        title="드론을 몰라도 괜찮아요, 기초부터 짚고 갑니다"
        description="Drawn은 AircraftVerse 데이터셋의 27,714개 드론 설계를 다루는 도구예요. 버튼 누르는 법보다, 화면에 나오는 수치와 형태가 실제로 뭘 뜻하는지부터 정리했습니다 — 전부 우리 데이터로 직접 확인한 내용이에요."
        actions={
          <Button onClick={onBack} variant="outline" className="border-[#e5e5ea] bg-white text-[#3c3c43] hover:bg-[#f5f5f7]">
            <ArrowLeft /> 설계 선택으로 돌아가기
          </Button>
        }
      />

      <section className="workspace-panel rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Zap className="size-4 text-[#3182f6]" /> 드론은 어떻게 뜨나요?
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">
          비행은 결국 4가지 힘의 줄다리기예요. 추력이 중력을 이기면 뜨고, 항력을 뚫고 나가면 앞으로 가고,
          날개가 있으면 양력이 추가로 도와줍니다.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {FORCES.map((force) => (
            <div key={force.label}>
              <MediaPlaceholder label={`${force.label} 이미지/애니메이션 자리`} />
              <p className="mt-2 text-xs font-semibold text-[#3c3c43]">{force.label}</p>
              <p className="mt-1 text-[11px] leading-4 text-[#6e6e73]">{force.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Layers3 className="size-4 text-[#3182f6]" /> 드론은 어떤 부품으로 이루어져 있나요?
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-[280px_1fr]">
          <MediaPlaceholder label="드론 부품 대표 이미지 자리" className="aspect-square lg:aspect-auto lg:h-full" />
          <div className="divide-y divide-[#e5e5ea]">
            {PARTS.map((part) => (
              <div key={part.label} className="py-2.5">
                <p className="text-xs font-semibold text-[#3c3c43]">{part.label}</p>
                <p className="mt-1 text-[11px] leading-5 text-[#6e6e73]">{part.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Boxes className="size-4 text-[#3182f6]" /> 드론의 형태, 그리고 그게 곧 설계도의 기본 틀입니다
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-[280px_1fr]">
          <MediaPlaceholder label="형태별(쿼드/헥사/옥토/고정익) 대표 이미지 자리" className="aspect-square lg:aspect-auto lg:h-full" />
          <div>
            <p className="text-sm leading-6 text-[#6e6e73]">
              지금부터 화면에서 보게 될 3D 모양이 곧 그 드론 설계의 기본 틀(설계도)이에요. 프로펠러 개수와
              날개 유무로 5가지 형태로 나뉘는데, 27,714개 전체를 직접 계산해보면 형태마다 뚜렷한 경향이
              있어요 (아래는 실제로 비행 가능하다고 확인된 설계만 놓고 평균낸 값).
            </p>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#e5e5ea] text-left text-[10px] uppercase tracking-[0.04em] text-[#86868b]">
                <th className="py-2 pr-3 font-medium">형태</th>
                <th className="py-2 pr-3 font-medium">설계 성공률</th>
                <th className="py-2 pr-3 font-medium">평균 질량</th>
                <th className="py-2 pr-3 font-medium">평균 비행거리</th>
                <th className="py-2 pr-3 font-medium">평균 체공시간</th>
                <th className="py-2 pr-3 font-medium">평균 소비전력</th>
                <th className="py-2 font-medium">전체 32개 최적 설계 중</th>
              </tr>
            </thead>
            <tbody>
              {AIRFRAME_STATS.map((row) => (
                <tr key={row.label} className="border-b border-[#e5ebef]">
                  <td className="py-2.5 pr-3 font-medium text-[#3c3c43]">{row.label}</td>
                  <td className="py-2.5 pr-3 font-mono text-[#3c3c43]">{row.successRate}</td>
                  <td className="py-2.5 pr-3 font-mono text-[#3c3c43]">{row.mass}</td>
                  <td className="py-2.5 pr-3 font-mono text-[#3c3c43]">{row.distance}</td>
                  <td className="py-2.5 pr-3 font-mono text-[#3c3c43]">{row.hover}</td>
                  <td className="py-2.5 pr-3 font-mono text-[#3c3c43]">{row.power}</td>
                  <td className="py-2.5 font-mono text-[#3c3c43]">{row.pareto}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-[#86868b]">
          헥사콥터가 실제로 “잘 나는” 설계가 나올 확률이 가장 높고, 쿼드콥터는 가장 가볍고 효율적이라 전체에서
          진짜 최적이라 부를 수 있는 설계의 66%를 차지해요. 이 패턴은 Drawn이 쓰는 AircraftVerse
          데이터셋 안에서 나온 결과이고, 드론 공학의 절대 법칙은 아니에요.
        </p>

        <div className="mt-5 border-t border-[#e5ebef] pt-4">
          <p className="text-sm leading-6 text-[#6e6e73]">
            형태만으로는 “어디에 쓰기 좋은지” 알기 어려워서, 실제로 비행 가능한 10,737개 설계를 질량·비행거리·
            체공시간·속도·소비전력 5가지 기준으로 컴퓨터가 스스로 5개 그룹으로 묶도록 했어요(군집분석). 사람이
            미리 정한 기준이 아니라 데이터가 알아서 나눈 결과예요.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {PURPOSE_CLUSTERS.map((cluster) => (
              <div key={cluster.label} className="rounded-xl border border-[#e5e5ea] bg-[#f5f5f7] p-3.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-[#3c3c43]">{cluster.label}</p>
                  <span className="font-mono text-[10px] text-[#86868b]">{cluster.share}</span>
                </div>
                <p className="mt-1.5 text-[11px] leading-5 text-[#6e6e73]">{cluster.desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-[#86868b]">
            형태(구조)와 목적(용도)은 완전히 같은 게 아니에요 — 같은 쿼드콥터라도 어떻게 설계하느냐에 따라
            경량형이 될 수도, 고속형이 될 수도 있습니다.
          </p>
        </div>

        <div className="mt-5 border-t border-[#e5ebef] pt-4">
          <p className="text-sm leading-6 text-[#6e6e73]">
            다만 이 설계도가 전부 같은 정밀도는 아니에요. 27,714개 중{' '}
            <strong className="text-[#1b64da]">12개만 실제로 정밀하게 만들어진 3D 파일(STL)</strong>이 있어서
            정확한 모습 그대로 보이고, 나머지 27,702개는 저장된 치수만으로 앱이 그 자리에서 계산해 그려주는
            근사치예요. 요약 수치(질량·비행거리 등)는 12개든 27,702개든 전부 진짜 데이터라 믿고 봐도 되지만,
            정확한 겉모습과 속도별 세부 성능은 정밀 3D 12개에서만 볼 수 있어요.
          </p>
        </div>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Target className="size-4 text-[#3182f6]" /> 설계 카드, 이렇게 읽으면 됩니다
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">
          “설계 카드”는 설계 선택 화면에서 드론 하나하나의 정보를 보여주는 네모난 박스예요. 아래 자리에
          실제 카드 예시 이미지가 들어갈 예정이에요.
        </p>
        <MediaPlaceholder label="설계 카드 예시(캡처) 자리" className="mt-3 aspect-[21/9]" />
        <div className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {[
            ['질량', '기체 전체 무게 (사람으로 치면 몸무게).'],
            ['비행거리', '배터리를 완전히 채운 상태에서 갈 수 있는 최대 거리.'],
            ['체공 시간', '이동하지 않고 제자리에서 떠 있을 수 있는 시간.'],
            ['최고 속도', '낼 수 있는 가장 빠른 속도.'],
          ].map(([label, desc]) => (
            <div key={label} className="grid grid-cols-[90px_1fr] gap-3 py-2 text-xs">
              <span className="font-medium text-[#3c3c43]">{label}</span>
              <span className="text-[#6e6e73]">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Sparkles className="size-4 text-[#3182f6]" /> 설계를 편집하면 성능이 바로 정확하게 계산되나요?
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">
          아니요, <strong>추정치</strong>예요. “파라미터 편집” 화면에서 치수를 바꾸면 성능 변화가 바로 뜨는데,
          이건 실제로 다시 시뮬레이션한 값이 아니라 데이터셋에서 비슷한 설계 5개를 찾아 가중평균한 근사치입니다
          (화면에 작게 “INTERPOLATED”라고 표시돼요). 정밀 3D가 있는 12개를 편집해도 마찬가지고요.
        </p>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">
          그리고 “성능 확인” 화면의 속도별 곡선은 <strong>편집 내용을 반영하지 않고 항상 원본 그대로</strong> 보여줍니다.
          편집한 설계의 속도별 변화를 보고 싶어도, 그 기능은 아직 없어요 — 편집 화면의 추정 패널이 지금 볼 수 있는 전부입니다.
        </p>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Route className="size-4 text-[#3182f6]" /> 전체 사용 흐름 (4개 작업 탭)
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOW_STEPS.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="rounded-xl border border-[#e5e5ea] bg-[#f5f5f7] p-3.5">
              <Icon className="size-4 text-[#3182f6]" />
              <p className="mt-2 text-xs font-semibold text-[#3c3c43]">{label}</p>
              <p className="mt-1 text-[11px] leading-4 text-[#6e6e73]">{desc}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#1b64da]">
            <Sparkles className="size-4" /> 설계 도우미 AI
          </p>
          <p className="mt-2 text-xs leading-5 text-[#6e6e73]">
            작업 중 상단의 설계 도우미 AI를 열면 오른쪽 패널에서 부품 찾기·설계 개선·질문하기를 이용할 수 있어요.
            부품 찾기는 현재 설계의 부품 목록과 수량을 확인하고, 상품 가격·구매 링크 비교부터 견적 저장·CSV 내보내기까지 이어집니다.
            설계 개선에서는 원하는 목표에 맞는 후보와 변경안을 비교하고, 질문하기에서는 현재 설계의 수치와 근거를 확인해 보세요.
          </p>
          <p className="mt-2 text-xs leading-5 text-[#6e6e73]">
            넓은 화면에서는 패널을 펼쳐 상품을 비교할 수 있고, 모바일에서는 하단 시트로 열립니다.
            AI 실행과 개인 저장은 Google 로그인 후 이용하며, 화면을 닫거나 다른 모드를 보더라도 선택한 구매 후보는 유지돼요.
          </p>
        </div>
      </section>

      <section className="workspace-panel mt-4 rounded-2xl p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[#1d1d1f]">
          <Gauge className="size-4 text-[#3182f6]" /> 자주 나오는 용어
        </h2>
        <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {GLOSSARY.map((item) => (
            <div key={item.term} className="flex gap-3 text-xs">
              <span className="w-24 shrink-0 font-medium text-[#3c3c43]">{item.term}</span>
              <span className="text-[#6e6e73]">{item.def}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 flex items-center gap-1.5 text-[11px] text-[#86868b]">
          <Weight className="size-3" /> <CircleGauge className="size-3" /> <Wind className="size-3" /> 이 외에도 헷갈리는 용어가 있으면 화면 각 항목에 붙은 물음표·툴팁을 확인해 보세요.
        </p>
      </section>

      <div className="mt-5 flex justify-center">
        <Button onClick={onBack} className="bg-[#3182f6] text-white hover:bg-[#1b64da]">
          <ArrowLeft /> 설계 선택으로 돌아가기
        </Button>
      </div>
    </section>
  );
}
