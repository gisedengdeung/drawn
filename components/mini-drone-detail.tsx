'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Bot, Check, ChevronLeft, ChevronRight, Minus, Package, Plus } from 'lucide-react';
import { miniDronePackage as product, packageWon as won } from '@/lib/mini-drone-package';

const gallery = [
  { label: '패키지 전체', position: 'center', scale: 1 },
  { label: '드론 자세히', position: 'center 85%', scale: 1.7 },
  { label: '조종기와 구성품', position: 'center top', scale: 1.7 },
];

export function MiniDroneDetail() {
  const [imageIndex, setImageIndex] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const selectedImage = gallery[imageIndex];
  const discount = Math.round((1 - product.price / product.original) * 100);

  return (
    <main className="min-h-screen bg-white text-[#20272e]">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex min-h-16 max-w-[1440px] flex-wrap items-center justify-between gap-3 px-5 py-3 lg:px-8">
          <Link href="/packages" className="flex items-center gap-2 text-sm font-semibold"><Package className="size-6 text-[#147d91]" />Drawn <span className="ml-2 border-l pl-4 font-normal text-slate-500">패키지 스토어</span></Link>
          <Link href="/packages" className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs hover:bg-slate-50"><ArrowLeft className="size-4" />패키지 목록</Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-5 pb-12 lg:px-8">
        <nav aria-label="현재 위치" className="flex flex-wrap items-center gap-2 py-5 text-xs text-slate-500"><Link href="/packages" className="hover:text-[#147d91]">패키지 상품</Link><ChevronRight className="size-3" /><span>입문·취미</span><ChevronRight className="size-3" /><span className="text-slate-700">미니 드론 패키지</span></nav>

        <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-0">
          <section aria-label="상품 이미지" className="min-w-0 lg:pr-9">
            <div className="relative aspect-square overflow-hidden bg-[#eee8df]">
              <Image src={product.image} alt={`${product.name} — ${selectedImage.label} 예시 이미지`} width={1254} height={1254} className="h-full w-full object-cover transition-transform duration-300" style={{ transform: `scale(${selectedImage.scale})`, transformOrigin: selectedImage.position }} />
              <span className="absolute bottom-4 right-4 rounded-full bg-black/55 px-3 py-1 text-xs text-white">{imageIndex + 1} / {gallery.length}</span>
            </div>
            <div className="mt-4 flex items-center justify-center gap-3" aria-label="상품 이미지 선택">
              <button type="button" aria-label="이전 상품 이미지" onClick={() => setImageIndex((current) => (current + gallery.length - 1) % gallery.length)} className="rounded p-2 text-slate-400 hover:bg-slate-100"><ChevronLeft className="size-5" /></button>
              {gallery.map((item, index) => <button type="button" key={item.label} aria-label={item.label} aria-pressed={imageIndex === index} onClick={() => setImageIndex(index)} className={`size-14 overflow-hidden rounded-md border-2 ${imageIndex === index ? 'border-[#147d91]' : 'border-transparent hover:border-slate-300'}`}><Image src={product.image} alt="" width={56} height={56} className="h-full w-full object-cover" style={{ transform: `scale(${item.scale})`, transformOrigin: item.position }} /></button>)}
              <button type="button" aria-label="다음 상품 이미지" onClick={() => setImageIndex((current) => (current + 1) % gallery.length)} className="rounded p-2 text-slate-400 hover:bg-slate-100"><ChevronRight className="size-5" /></button>
            </div>
            <p className="mt-3 text-center text-[11px] leading-5 text-slate-400">AI로 제작한 상품 예시 이미지입니다.</p>
          </section>

          <section aria-label="상품 구매 정보" className="min-w-0 lg:border-l lg:border-slate-200 lg:pl-9">
            <div className="mb-3 flex items-center gap-2 text-xs"><span className="rounded bg-[#eef8f8] px-2 py-1 font-semibold text-[#147d91]">입문·취미 추천</span><span className="text-slate-400">예시 상품</span></div>
            <h1 className="text-2xl leading-snug font-medium tracking-tight sm:text-[28px]">{product.name}</h1>
            <p className="mt-3 text-sm leading-6 text-slate-500">드론부터 조종기, 배터리까지.<br />처음 시작하는 데 필요한 5종을 한 번에 준비하세요.</p>
            <div className="mt-6"><p className="text-sm text-slate-400">개별 구매 합계 <del className="ml-1 text-lg">{won(product.original)}</del></p><p className="mt-1 flex items-baseline gap-3"><span className="text-2xl font-semibold">{discount}%</span><strong className="text-4xl font-bold tracking-tight text-[#e60023]">{won(product.price)}</strong></p><p className="mt-3 text-xs text-slate-500">패키지 구매 시 <span className="font-medium text-[#147d91]">{won(product.original - product.price)} 절약</span></p></div>

            <section aria-labelledby="recommendation-title" className="my-6 border-y border-slate-200 py-5">
              <div className="flex items-center gap-2"><Bot className="size-4 text-[#147d91]" /><h2 id="recommendation-title" className="text-sm font-semibold">AI 에이전트의 추천 이유</h2><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">예시</span></div>
              <p className="mt-3 text-xs leading-6 text-slate-500">“처음 드론을 접하는 분께는 필요한 구성을 따로 고르는 번거로움과 시작 비용을 줄이는 것이 중요하다고 보았어요. 이 패키지는 10만 원 미만의 예산에 조종기와 시작 가이드를 함께 담아, 입문·취미 목적으로 가볍게 시작하기 좋은 구성입니다.”</p>
              <div className="mt-3 grid gap-2 text-xs leading-5 text-slate-500">
                <p><span className="font-medium text-slate-700">선택 부담 ↓</span> · 드론과 맞춰 쓸 조종기를 한 패키지로 준비해요.</p>
                <p><span className="font-medium text-slate-700">연습 준비</span> · 여분 배터리와 프로펠러 가드, 시작 가이드를 포함했어요.</p>
                <p><span className="font-medium text-slate-700">예산에 적합</span> · {won(product.price)}으로 기본 구성품 5종을 마련할 수 있어요.</p>
              </div>
            </section>

            <section aria-labelledby="contents-title" className="grid grid-cols-[64px_1fr] gap-4 border-b border-slate-200 pb-5 text-xs sm:grid-cols-[80px_1fr]">
              <h2 id="contents-title" className="pt-0.5 text-slate-500">패키지 구성</h2>
              <ul className="grid gap-2 sm:grid-cols-2">{product.items.map((item) => <li key={item} className="flex items-center gap-2 leading-5 text-slate-600"><Check className="size-3.5 shrink-0 text-[#147d91]" />{item}</li>)}</ul>
            </section>
            <div className="grid grid-cols-[64px_1fr] gap-4 py-5 text-xs sm:grid-cols-[80px_1fr]"><span className="text-slate-500">배송 안내</span><p className="leading-5 text-slate-500">예시 상품으로 배송 일정과 배송비는 아직 정해지지 않았어요.</p></div>

            <div className="overflow-hidden rounded-lg border border-slate-200">
              <div className="flex items-center justify-between gap-3 bg-[#f7f9fc] px-5 py-4"><h2 className="text-sm font-semibold">수량 선택</h2><div className="flex items-center overflow-hidden rounded border border-slate-300 bg-white"><button type="button" aria-label="수량 줄이기" disabled={quantity === 1} onClick={() => setQuantity((current) => Math.max(1, current - 1))} className="p-2.5 hover:bg-slate-50 disabled:text-slate-300"><Minus className="size-4" /></button><output aria-label="선택 수량" className="min-w-10 border-x border-slate-200 px-2 py-2 text-center text-sm font-semibold">{quantity}</output><button type="button" aria-label="수량 늘리기" disabled={quantity === 99} onClick={() => setQuantity((current) => Math.min(99, current + 1))} className="p-2.5 hover:bg-slate-50 disabled:text-slate-300"><Plus className="size-4" /></button></div></div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-5"><p className="text-sm font-semibold">총 <span className="text-[#e60023]">{quantity}</span>개</p><output aria-live="polite" aria-label="총 상품 금액" className="flex items-baseline gap-3"><span className="text-sm font-semibold">총 금액</span><strong className="text-2xl text-[#e60023]">{won(product.price * quantity)}</strong></output></div>
            </div>
            <p className="mt-4 text-[11px] leading-5 text-slate-400">상품·가격·추천 이유는 화면 확인을 위한 예시입니다. 실제 결제는 지원하지 않습니다.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
