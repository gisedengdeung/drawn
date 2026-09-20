'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, Check, Package, Search, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { PackageContentsButton } from '@/components/package-contents-button';
import { miniDronePackage } from '@/lib/mini-drone-package';

const purposes = ['입문·취미', '여행·촬영', '교육·코딩', '레이싱'] as const;
const priceRanges = [
  { label: '전체 가격', min: 0, max: Infinity },
  { label: '10만 원 미만', min: 0, max: 100000 },
  { label: '10만 ~ 30만 원 미만', min: 100000, max: 300000 },
  { label: '30만 ~ 50만 원 미만', min: 300000, max: 500000 },
  { label: '50만 원 이상', min: 500000, max: Infinity },
];

const products = [
  miniDronePackage,
  { id: 'weekend', name: '주말 나들이 올인원 패키지', purpose: '입문·취미', description: '드론부터 보관 가방까지 한 번에.', price: 129000, original: 169000, color: '#159b9a', tag: '알뜰 구성', items: ['접이식 드론', '조종기', '배터리 2개', '충전 케이블', '보관 가방'] },
  { id: 'travel', name: '여행 기록 카메라 드론 패키지', purpose: '여행·촬영', description: '여행의 풍경을 새로운 시선으로 담아요.', price: 279000, original: 349000, color: '#7292b0', tag: '여행 추천', items: ['카메라 드론', '조종기', '배터리 2개', '메모리 카드', '휴대용 케이스'] },
  { id: 'coding', name: '차근차근 코딩 드론 패키지', purpose: '교육·코딩', description: '직접 코딩하고 날려보는 즐거운 첫 수업.', price: 189000, original: 239000, color: '#a48ad4', tag: '배우는 즐거움', items: ['교육용 드론', '프로펠러 가드', '배터리 2개', '코딩 교재', '미션 카드'] },
  { id: 'race', name: '스피드 FPV 입문 패키지', purpose: '레이싱', description: '몰입감 있는 비행을 위한 첫 세트.', price: 399000, original: 499000, color: '#db6674', tag: '취미 확장', items: ['FPV 드론', '조종기', 'FPV 고글', '배터리 3개', '충전기'] },
  { id: 'photo', name: '풍경 촬영 플러스 패키지', purpose: '여행·촬영', description: '촬영 액세서리까지 넉넉하게 준비해요.', price: 649000, original: 799000, color: '#586879', tag: '촬영 풀세트', items: ['촬영용 드론', '화면형 조종기', '배터리 3개', '충전 허브', '필터 세트', '숄더백'] },
];

const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;

function PackageIllustration({ color, name }: { color: string; name: string }) {
  return (
    <svg viewBox="0 0 320 220" aria-label={`${name} 구성 예시 일러스트`} className="h-full w-full">
      <title>{`${name} 구성 예시 일러스트`}</title>
      <ellipse cx="160" cy="137" rx="105" ry="12" fill="#172b3a" opacity=".07" />
      <g stroke="#586879" strokeWidth="12" strokeLinecap="round">
        <path d="M143 91 94 59 M177 91 226 59 M143 106 94 128 M177 106 226 128" />
      </g>
      {[{x:94,y:59},{x:226,y:59},{x:94,y:128},{x:226,y:128}].map(({x,y}) => (
        <g key={`${x}-${y}`}>
          <ellipse cx={x} cy={y} rx="36" ry="10" fill="#344757" opacity=".85" />
          <circle cx={x} cy={y} r="7" fill="#b8c7d0" />
          <circle cx={x} cy={y} r="3" fill="#344757" />
        </g>
      ))}
      <rect x="136" y="63" width="48" height="65" rx="18" fill={color} />
      <path d="M145 77H175" stroke="white" strokeWidth="3" opacity=".55" />
      <rect x="149" y="114" width="22" height="17" rx="5" fill="#253947" />
      <circle cx="160" cy="122" r="5" fill="#a8dfe2" />
      <g transform="translate(60 163)">
        <rect width="70" height="38" rx="12" fill="#3d5060" />
        <circle cx="18" cy="17" r="7" fill="#1b2c38" /><circle cx="52" cy="17" r="7" fill="#1b2c38" />
        <path d="M29 27h12" stroke={color} strokeWidth="3" />
      </g>
      {[153,180].map((x) => <g key={x}><rect x={x} y="167" width="19" height="32" rx="4" fill="#91a2af" /><path d={`M${x+5} 174h9`} stroke="white" strokeWidth="2" /></g>)}
      <rect x="220" y="165" width="43" height="36" rx="7" fill={color} opacity=".3" />
      <path d="M231 164v-4h20v4" fill="none" stroke="#708694" strokeWidth="3" />
    </svg>
  );
}

export function PackageShop() {
  const [query, setQuery] = useState('');
  const [priceIndex, setPriceIndex] = useState(0);
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>([]);
  const [sort, setSort] = useState('recommended');
  const range = priceRanges[priceIndex];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = products.filter((product) =>
    product.price >= range.min && product.price < range.max &&
    (!selectedPurposes.length || selectedPurposes.includes(product.purpose)) &&
    [product.name, product.purpose, product.description, ...product.items].join(' ').toLocaleLowerCase().includes(normalizedQuery),
  ).sort((a, b) => sort === 'low' ? a.price - b.price : sort === 'high' ? b.price - a.price : 0);
  const hasFilters = query !== '' || priceIndex !== 0 || selectedPurposes.length > 0;
  const reset = () => { setQuery(''); setPriceIndex(0); setSelectedPurposes([]); };

  return (
    <main className="min-h-screen bg-[#f7f9fb] text-[#172b3a]">
      <header className="border-b border-[#dbe4ea] bg-white">
        <div className="mx-auto flex min-h-16 max-w-[1440px] flex-wrap items-center justify-between gap-3 px-5 py-3 lg:px-8">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold"><Package className="size-6 text-[#147d91]" /> AeroTwin <span className="ml-2 border-l pl-4 font-normal text-slate-500">패키지 스토어</span></Link>
          <Link href="/" className="flex items-center gap-2 rounded-lg border border-[#dbe4ea] px-3 py-2 text-xs hover:bg-slate-50"><ArrowLeft className="size-4" /> 1–5단계로 돌아가기</Link>
        </div>
      </header>
      <div className="mx-auto max-w-[1440px] px-5 py-8 lg:px-8">
        <section className="mb-7 rounded-2xl border border-teal-100 bg-[#eef8f8] p-6 sm:p-8">
          <p className="mb-3 text-xs font-bold tracking-widest text-[#147d91]">누구나 시작하는 드론 라이프</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">첫 드론, 패키지로 부담 없이!</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">어려운 부품 선택 없이, 필요한 구성품을 한 번에.<br className="sm:hidden" /> 내 예산과 목적에 맞는 드론을 찾아보세요.</p>
          <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium text-[#0f6475]">
            {['드론 + 필수 액세서리', '한눈에 보는 패키지 가격', '목적에 맞춘 쉬운 선택'].map((text) => <span key={text} className="flex items-center gap-1.5"><Check className="size-4" />{text}</span>)}
          </div>
        </section>

        <label className="mb-7 flex items-center gap-3 rounded-xl border border-[#cfdbe2] bg-white px-4 focus-within:ring-2 focus-within:ring-[#147d91]">
          <Search className="size-5 shrink-0 text-[#147d91]" />
          <span className="sr-only">패키지 상품 검색</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="어떤 드론을 찾으세요? 상품명, 용도, 구성품 검색" className="h-13 min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>

        <div className="grid items-start gap-6 lg:grid-cols-[220px_1fr]">
          <aside className="rounded-xl border border-[#dbe4ea] bg-white p-5" aria-label="상품 필터">
            <div className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="size-4" /> 필터</h2><button onClick={reset} disabled={!hasFilters} className="flex items-center gap-1 text-xs text-slate-500 hover:text-[#147d91] disabled:opacity-40"><RotateCcw className="size-3" /> 초기화</button></div>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1">
              <fieldset><legend className="mb-3 text-sm font-semibold">가격대</legend><div className="space-y-3">{priceRanges.map((price, index) => <label key={price.label} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600"><input type="radio" name="price" checked={priceIndex === index} onChange={() => setPriceIndex(index)} className="size-4 accent-[#147d91]" />{price.label}</label>)}</div></fieldset>
              <fieldset><legend className="mb-3 text-sm font-semibold">사용목적 <span className="text-xs font-normal text-slate-400">복수 선택</span></legend><div className="space-y-3">{purposes.map((purpose) => <label key={purpose} className="flex cursor-pointer items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={selectedPurposes.includes(purpose)} onChange={() => setSelectedPurposes((current) => current.includes(purpose) ? current.filter((value) => value !== purpose) : [...current, purpose])} className="size-4 accent-[#147d91]" />{purpose}</label>)}</div></fieldset>
            </div>
          </aside>

          <section aria-label="패키지 상품 목록" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#dbe4ea] bg-white px-4 py-3">
              <output className="text-sm" aria-live="polite">패키지 상품 <strong className="text-[#147d91]">{filtered.length}</strong>개</output>
              <select aria-label="상품 정렬" value={sort} onChange={(event) => setSort(event.target.value)} className="rounded-md border border-[#dbe4ea] bg-white px-3 py-2 text-xs"><option value="recommended">추천순</option><option value="low">낮은 가격순</option><option value="high">높은 가격순</option></select>
            </div>
            <p className="mb-4 text-xs leading-5 text-slate-500">구매 화면 예시입니다. 상품·가격·할인·구성은 예시이며 실제 주문은 지원하지 않습니다.</p>
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#cfdbe2] bg-white px-5 py-20 text-center"><Search className="mx-auto mb-4 size-8 text-slate-400" /><h2 className="font-semibold">조건에 맞는 패키지가 없어요</h2><p className="mt-2 text-sm text-slate-500">검색어를 바꾸거나 가격대와 사용목적을 넓혀보세요.</p><button onClick={reset} className="mt-5 rounded-lg bg-[#147d91] px-4 py-2 text-sm font-medium text-white">전체 상품 보기</button></div>
            ) : <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((product) => (
              <article key={product.id} className="overflow-hidden rounded-xl border border-[#dbe4ea] bg-white transition-shadow hover:shadow-md">
                <div className="relative aspect-[4/3] bg-[#f0f4f6]">
                  {product.id === 'mini' ? <Link href="/packages/mini" aria-label={`${product.name} 상세 보기`} className="block h-full"><Image src={miniDronePackage.image} alt="미니 드론과 조종기, 배터리로 구성한 패키지 예시" width={1254} height={1254} className="h-full w-full object-cover" /></Link> : <div className="h-full p-3"><PackageIllustration color={product.color} name={product.name} /></div>}
                  <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-[#147d91] px-2 py-1 text-[11px] font-semibold text-white">{product.tag}</span><span className="pointer-events-none absolute bottom-2 right-3 rounded bg-white/85 px-1 text-[10px] text-slate-600">구성 예시 이미지</span>
                </div>
                <div className="p-5"><span className="rounded bg-[#eef8f8] px-2 py-1 text-[11px] font-medium text-[#147d91]">{product.purpose}</span><h2 className="mt-3 text-base font-semibold tracking-tight">{product.id === 'mini' ? <Link href="/packages/mini" className="underline-offset-4 hover:text-[#147d91] hover:underline">{product.name}</Link> : product.name}</h2><p className="mt-2 text-xs leading-5 text-slate-500">{product.description}</p>
                  <p className="mt-5 text-xs text-slate-400">개별 구매 합계 <del>{won(product.original)}</del></p><div className="mt-1 flex items-baseline gap-2"><span className="text-lg font-bold text-rose-600">{Math.round((1 - product.price / product.original) * 100)}%</span><strong className="text-2xl tracking-tight">{won(product.price)}</strong></div><p className="mt-1 text-xs font-medium text-[#147d91]">패키지로 {won(product.original - product.price)} 절약</p>
                  <div className="mt-5 border-t border-[#e5ebef] pt-3"><PackageContentsButton name={product.name} items={product.items} /></div>
                </div>
              </article>
            ))}</div>}
          </section>
        </div>
      </div>
    </main>
  );
}
