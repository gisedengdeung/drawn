'use client';

import { ChangeEvent, useRef } from 'react';
import { Palette, Upload, Check } from 'lucide-react';
import { DRONE_SKINS, DroneSkin } from '@/lib/skin-data';

type SkinParameterCardProps = {
  selectedSkin: DroneSkin;
  onSelectSkin: (skin: DroneSkin) => void;
  customTextureUrl: string | null;
  onCustomTextureUpload: (textureUrl: string) => void;
};

export function SkinParameterCard({
  selectedSkin,
  onSelectSkin,
  customTextureUrl,
  onCustomTextureUpload,
}: SkinParameterCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const imageUrl = URL.createObjectURL(file);
      onCustomTextureUpload(imageUrl);
    }
  };

  return (
    <div className="rounded-xl border border-[#e2e9ee] bg-[#f8fafb] p-3 space-y-3">
      {/* Header 영역 */}
      <div className="flex items-center gap-2">
        <Palette className="w-4 h-4 text-[#147d91]" />
        <span className="text-xs font-semibold text-[#294353]">
          기본 색상 선택
        </span>
      </div>

      {/* 색상 선택 버튼 목록 */}
      <div className="grid grid-cols-3 gap-2">
        {DRONE_SKINS.map((skin) => {
          const isSelected = selectedSkin.id === skin.id && !customTextureUrl;
          return (
            <button
              key={skin.id}
              type="button"
              onClick={() => onSelectSkin(skin)}
              className={`relative flex items-center gap-2 p-2 text-xs rounded-lg border transition-all ${
                isSelected
                  ? 'border-[#147d91] bg-white font-semibold text-[#294353] shadow-sm'
                  : 'border-[#dbe4ea] bg-[#f8fafb] text-slate-600 hover:bg-white'
              }`}
            >
              {/* 색상 미리보기 써클 */}
              <span
                className="size-3.5 rounded-full border border-gray-300 shrink-0"
                style={{ backgroundColor: skin.color }}
              />
              <span className="truncate">{skin.name}</span>
              {isSelected && (
                <Check className="w-3 h-3 text-[#147d91] ml-auto shrink-0" />
              )}
            </button>
          );
        })}
      </div>

      <div className="border-t border-[#e2e9ee]" />

      {/* 사용자 지정 파일 업로드 */}
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-[#294353]">
          커스텀 스킨 업로드
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`w-full flex items-center justify-center gap-2 py-2 px-3 rounded-lg border border-dashed text-xs transition-all ${
            customTextureUrl
              ? 'border-[#147d91] bg-white text-[#147d91] font-medium'
              : 'border-[#dbe4ea] bg-white hover:bg-slate-50 text-slate-600'
          }`}
        >
          <Upload className="w-3.5 h-3.5" />
          {customTextureUrl ? '스킨 이미지 변경' : '스킨 파일 업로드 (.png, .jpg)'}
        </button>
      </div>
    </div>
  );
}