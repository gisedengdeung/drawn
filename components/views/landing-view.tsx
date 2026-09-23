'use client';

import { ArrowRight, Boxes, Gauge, HelpCircle, Route } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DrawnLogo } from '@/components/drawn-logo';
import { ParametricUavViewer } from '@/components/parametric-uav-viewer';
import { useDesignWorkspace } from '@/hooks/use-design-workspace';
import type { DesignSummary } from '@/lib/drawn-types';

export function LandingView({
  heroDesign = null,
  onStart,
  onOpenGuide,
}: {
  heroDesign?: DesignSummary | null;
  onStart: () => void;
  onOpenGuide: () => void;
}) {
  // 카드 뒤 배경일 뿐이라 편집 UI는 필요 없다 — draft/placements만 뽑아 쓴다.
  const { draft: heroDraft, placements: heroPlacements } = useDesignWorkspace(heroDesign, null, null, 0);

  return (
    <section className="relative grid min-h-screen place-items-center px-6 py-10">
      {heroDraft && (
        // 배경은 뷰포트 전체를 채워야 하므로 max-w로 좁혀진 페이지 레이아웃과 무관하게 fixed로 띄운다.
        <div className="fixed inset-0 z-0">
          <ParametricUavViewer
            draft={heroDraft}
            assembly={heroPlacements}
            autoRotate
            selection={[]}
            onSelectionChange={() => {}}
          />
        </div>
      )}
      <div className="relative z-10 w-full max-w-xl p-8 text-center [text-shadow:0_1px_3px_rgba(255,255,255,0.9),0_2px_16px_rgba(255,255,255,0.85)]">
        <DrawnLogo className="mx-auto mb-6 size-16 rounded-2xl shadow-sm" />
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-[#1d1d1f]">Drawn</h1>
        <p className="mt-3 text-sm leading-6 text-[#6e6e73]">
          AircraftVerse 데이터셋에 담긴 27,714개의 실제 드론 설계를 둘러보고, 치수를 직접 조정해보고,
          원하는 조건에 맞는 기체를 찾아보세요. 드론을 잘 몰라도 괜찮아요.
        </p>

        <div className="mt-6 grid grid-cols-3 gap-2">
          <div className="workspace-panel rounded-xl p-3">
            <Boxes className="mx-auto size-4 text-[#3182f6]" />
            <p className="mt-2 font-mono text-sm font-semibold text-[#1d1d1f]">27,714개</p>
            <p className="mt-0.5 text-[10px] text-[#6e6e73]">실제 드론 설계</p>
          </div>
          <div className="workspace-panel rounded-xl p-3">
            <Gauge className="mx-auto size-4 text-[#3182f6]" />
            <p className="mt-2 font-mono text-sm font-semibold text-[#1d1d1f]">12개</p>
            <p className="mt-0.5 text-[10px] text-[#6e6e73]">정밀 3D 모델</p>
          </div>
          <div className="workspace-panel rounded-xl p-3">
            <Route className="mx-auto size-4 text-[#3182f6]" />
            <p className="mt-2 font-mono text-sm font-semibold text-[#1d1d1f]">4단계</p>
            <p className="mt-0.5 text-[10px] text-[#6e6e73]">선택부터 공유까지</p>
          </div>
        </div>

        <p className="mt-4 text-xs leading-5 text-[#6e6e73]">설계 도우미 AI에서 부품 찾기·설계 개선·질문하기도 함께 이용해 보세요.</p>

        <Button onClick={onStart} className="mt-7 h-11 w-full bg-[#3182f6] text-base text-white hover:bg-[#1b64da]">
          시작하기 <ArrowRight />
        </Button>
        <Button onClick={onOpenGuide} variant="outline" className="mt-2 h-11 w-full border-[#e5e5ea] bg-white text-[#3c3c43] hover:bg-[#f5f5f7]">
          <HelpCircle /> 초보자용 가이드
        </Button>
        <p className="mt-3 text-[11px] text-[#86868b]">드론을 잘 몰라도 괜찮아요 — 3분 안에 화면 용어와 사용 흐름을 정리해드릴게요.</p>
      </div>
    </section>
  );
}
