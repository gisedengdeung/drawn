'use client';

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';

export function PackageContentsButton({ name, items }: { name: string; items: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger type="button" className="w-full cursor-pointer rounded-md border border-[#e5e5ea] bg-white px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-[#3182f6] hover:text-[#3182f6]">
        패키지 구성 보기 · {items.length}종
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={8} className="max-w-[calc(100vw-32px)] bg-white p-4 text-[#1d1d1f] shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <PopoverTitle className="text-sm leading-5">{name}</PopoverTitle>
          <button type="button" aria-label="패키지 구성 닫기" onClick={() => setOpen(false)} className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100"><X className="size-4" /></button>
        </div>
        <ul className="space-y-2 border-t border-slate-100 pt-3">
          {items.map((item) => <li key={item} className="flex items-center gap-2 text-xs text-slate-600"><Check className="size-3.5 text-[#3182f6]" />{item}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
