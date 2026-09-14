"use client";

import React, { useState } from "react";
import { DRONE_SKINS, DroneSkin } from "@/lib/skin-data";

interface SkinSelectorProps {
  onSelectSkin?: (skin: DroneSkin) => void;
}

export default function SkinSelector({ onSelectSkin }: SkinSelectorProps) {
  const [selectedSkin, setSelectedSkin] = useState<DroneSkin>(DRONE_SKINS[0]);

  const handleSelect = (skin: DroneSkin) => {
    setSelectedSkin(skin);
    if (onSelectSkin) {
      onSelectSkin(skin);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-800">
      <h2 className="text-2xl font-bold mb-6 text-center tracking-wide text-emerald-400">
        드론 스킨 보관함
      </h2>

      {/* 스킨 카드가 나열되는 그리드 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        {DRONE_SKINS.map((skin) => {
          const isSelected = selectedSkin.id === skin.id;

          return (
            <div
              key={skin.id}
              onClick={() => handleSelect(skin)}
              className={`cursor-pointer rounded-lg p-4 transition-all duration-200 border-2 flex flex-col items-center text-center ${
                isSelected
                  ? "border-emerald-500 bg-slate-800 scale-105 shadow-lg shadow-emerald-500/20"
                  : "border-slate-700 bg-slate-800/50 hover:border-slate-500 hover:bg-slate-800"
              }`}
            >
              {/* 이미지 썸네일 영역 */}
              <div className="w-24 h-24 bg-slate-700 rounded-md mb-4 flex items-center justify-center overflow-hidden border border-slate-600 relative">
                {/* 텍스처 이미지가 없더라도 에러가 나지 않도록 이미지 표시 처리 */}
                <img
                  src={skin.thumbnailPath}
                  alt={skin.name}
                  className="w-full h-full object-contain"
                  onError={(e) => {
                    // 이미지 로드 실패 시 대체 대체 텍스트/플레이스홀더
                    (e.target as HTMLElement).style.display = "none";
                  }}
                />
                <span className="absolute text-xs text-slate-400 -z-0">
                  {skin.id}
                </span>
              </div>

              {/* 스킨 이름 및 설명 */}
              <h3 className="font-semibold text-lg text-slate-100">{skin.name}</h3>
              <p className="text-xs text-slate-400 mt-1">{skin.description}</p>

              {/* 선택 상태 뱃지 */}
              <div className="mt-4">
                {isSelected ? (
                  <span className="px-3 py-1 bg-emerald-500 text-slate-950 font-bold text-xs rounded-full">
                    장착 중
                  </span>
                ) : (
                  <span className="px-3 py-1 bg-slate-700 text-slate-300 text-xs rounded-full group-hover:bg-slate-600">
                    선택
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 하단 선택된 스킨 안내 바 */}
      <div className="p-4 bg-slate-800 rounded-lg border border-slate-700 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <span className="text-xs text-slate-400 block">현재 선택된 스킨</span>
          <span className="text-lg font-bold text-emerald-400">
            {selectedSkin.name}
          </span>
        </div>
        <button
          onClick={() => alert(`'${selectedSkin.name}' 스킨이 적용되었습니다.`)}
          className="w-full sm:w-auto px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg transition-colors"
        >
          스킨 적용하기
        </button>
      </div>
    </div>
  );
}