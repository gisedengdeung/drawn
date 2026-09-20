'use client';

import { ArrowRight, Boxes, Gauge, HelpCircle, Route } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DrawnLogo } from '@/components/drawn-logo';

export function LandingView({
  onStart,
  onOpenGuide,
}: {
  onStart: () => void;
  onOpenGuide: () => void;
}) {
  return (
    <section className="grid min-h-[calc(100vh-103px)] place-items-center px-6 py-10">
      <div className="w-full max-w-xl text-center">
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
            <p className="mt-2 font-mono text-sm font-semibold text-[#1d1d1f]">6단계</p>
            <p className="mt-0.5 text-[10px] text-[#6e6e73]">선택부터 공유까지</p>
          </div>
        </div>

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
