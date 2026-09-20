// 국토교통부_항공레저_초경량비행장치공역 CSV(data.go.kr, dataset id 15061946)를
// public/data/drone-zones.json으로 변환합니다.
//
// 데이터 원본은 로그인 없이 CSV로 직접 내려받을 수 있습니다:
//   https://www.data.go.kr/data/15061946/fileData.do
//
// 사용법:
//   node scripts/prepare-drone-zones.mjs --csv <다운로드한 CSV 경로>
//   (--csv 생략 시 기본 경로 data/sources/ul-airspace.csv 를 찾습니다)
//
// 실제 컬럼 구조(2025-12-31 스냅샷 기준, 웹 페이지 설명과 순서가 다름에 주의):
//   순번, 코드(예: "UA 2"), 위치(지명, 예: "구성산"),
//   수평범위(DMS 좌표 + "반경 N KM/M" 또는 " - "로 이어진 다각형 꼭짓점들),
//   수직범위(예: "500FT AGL"), 특기사항(예: "무인비행장치 전용구역")
//
// 원 형태(좌표 1개 + 반경)와 다각형(좌표 여러 개, 반경 없음) 두 가지가 섞여 있습니다.
// 다각형은 꼭짓점의 중심점을 대표 좌표로 쓰고 radiusKm은 null로 남겨 실제 경계와
// 혼동하지 않도록 합니다.
//
// CSV 원본은 저장소에 커밋하지 않습니다(.gitignore의 /data/ 규칙 재사용).
// 변환 결과인 public/data/drone-zones.json만 커밋 대상입니다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const defaultCsvPath = path.join(projectRoot, 'data', 'sources', 'ul-airspace.csv');
const outputPath = path.join(projectRoot, 'public', 'data', 'drone-zones.json');
const sourceUrl = 'https://www.data.go.kr/data/15061946/fileData.do';

function parseArgs(argv) {
  let csvPath = defaultCsvPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--csv') {
      const value = argv[index + 1];
      if (!value) throw new Error('--csv requires a file path.');
      csvPath = path.resolve(value);
      index += 1;
    } else if (argument.startsWith('--csv=')) {
      csvPath = path.resolve(argument.slice('--csv='.length));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return csvPath;
}

/** 국내 공공데이터 CSV는 UTF-8 또는 EUC-KR로 배포됩니다. 깨짐(U+FFFD)이 감지되면 EUC-KR로 재시도합니다. */
function readCsvText(csvPath) {
  const buffer = fs.readFileSync(csvPath);
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  return new TextDecoder('euc-kr').decode(buffer);
}

/** 따옴표로 감싼 필드의 콤마를 보존하는 최소 CSV 파서입니다. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

function findColumn(header, candidates) {
  const index = header.findIndex((name) =>
    candidates.some((candidate) => name.replace(/\s/g, '').includes(candidate)),
  );
  if (index === -1) {
    throw new Error(
      `CSV 헤더에서 [${candidates.join(', ')}] 중 하나를 찾지 못했습니다. 실제 헤더: ${header.join(' | ')}`,
    );
  }
  return index;
}

const DMS_PAIR = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([EW])/g;

/** "354421N1270027E" 형식(DDMMSSN DDDMMSSE)을 십진 위경도로 변환합니다. */
function dmsToDecimal(latDeg, latMin, latSec, latHemi, lngDeg, lngMin, lngSec, lngHemi) {
  const toDecimal = (deg, min, sec, hemi) => {
    const value = Number(deg) + Number(min) / 60 + Number(sec) / 3600;
    return hemi === 'S' || hemi === 'W' ? -value : value;
  };
  return {
    lat: toDecimal(latDeg, latMin, latSec, latHemi),
    lng: toDecimal(lngDeg, lngMin, lngSec, lngHemi),
  };
}

/** "수평범위" 필드에서 DMS 좌표를 전부 추출합니다. 원형은 1개, 다각형은 여러 개입니다. */
function extractPoints(rangeText) {
  return [...rangeText.matchAll(DMS_PAIR)].map((match) => dmsToDecimal(...match.slice(1)));
}

/** KM > M > NM 순으로 우선 탐색해 반경을 km 단위로 반환합니다. */
function parseRadiusKm(rangeText) {
  const km = rangeText.match(/([\d.]+)\s*KM/i);
  if (km) return Number(km[1]);
  const meters = rangeText.match(/([\d.]+)\s*M\b/i);
  if (meters) return Number(meters[1]) / 1000;
  const nm = rangeText.match(/([\d.]+)\s*NM/i);
  if (nm) return Number(nm[1]) * 1.852;
  return null;
}

function parseCeilingFt(rangeText) {
  const ft = rangeText.match(/([\d.]+)\s*FT/i);
  return ft ? Number(ft[1]) : null;
}

function average(numbers) {
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function main() {
  const csvPath = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(csvPath)) {
    console.error(
      `[prepare-drone-zones] CSV 파일을 찾을 수 없습니다: ${csvPath}\n` +
        `다음 주소에서 로그인 없이 CSV를 내려받아 위 경로에 두거나 --csv 옵션으로 경로를 지정하세요:\n  ${sourceUrl}`,
    );
    process.exitCode = 1;
    return;
  }

  const rows = parseCsv(readCsvText(csvPath));
  if (rows.length < 2) throw new Error('CSV에 데이터 행이 없습니다.');
  const [header, ...dataRows] = rows;

  const codeIndex = findColumn(header, ['코드', 'code']);
  const nameIndex = findColumn(header, ['위치', 'location']);
  const hRangeIndex = findColumn(header, ['수평범위', 'h_range', '수평']);
  const vRangeIndex = findColumn(header, ['수직범위', 'v_range', '수직']);
  const remarkIndex = findColumn(header, ['특기사항', 'remark', '비고']);

  const zones = [];
  const skipped = [];
  for (const cells of dataRows) {
    const code = (cells[codeIndex] ?? '').trim();
    const name = (cells[nameIndex] ?? '').trim();
    const hRangeText = (cells[hRangeIndex] ?? '').trim();
    const remark = (cells[remarkIndex] ?? '').trim();
    const points = extractPoints(hRangeText);
    if (!code || !name || points.length === 0) {
      skipped.push({ code, name, hRangeText });
      continue;
    }

    const isPolygon = points.length > 1;
    const lat = average(points.map((point) => point.lat));
    const lng = average(points.map((point) => point.lng));

    zones.push({
      id: code.replace(/\s+/g, ''),
      code,
      name,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      radiusKm: isPolygon ? null : parseRadiusKm(hRangeText),
      ceilingFt: parseCeilingFt(cells[vRangeIndex] ?? ''),
      shape: isPolygon ? 'polygon' : 'circle',
      // 다각형은 실제 꼭짓점을 보존해 지도에 근사 원이 아닌 실경계를 그릴 수 있게 합니다.
      vertices: isPolygon
        ? points.map((point) => ({ lat: Number(point.lat.toFixed(6)), lng: Number(point.lng.toFixed(6)) }))
        : undefined,
      remark: remark || null,
    });
  }

  if (zones.length === 0) throw new Error('파싱에 성공한 공역이 없습니다. CSV 형식을 확인하세요.');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        source: '국토교통부_항공레저_초경량비행장치공역',
        sourceUrl,
        generatedAt: new Date().toISOString().slice(0, 10),
        zones,
      },
      null,
      2,
    )}\n`,
  );

  const polygonCount = zones.filter((zone) => zone.shape === 'polygon').length;
  console.log(
    `[prepare-drone-zones] ${zones.length}개 공역을 ${path.relative(projectRoot, outputPath)}에 저장했습니다` +
      ` (원형 ${zones.length - polygonCount}, 다각형(중심점 근사) ${polygonCount})` +
      (skipped.length ? ` — 파싱 실패 ${skipped.length}건 건너뜀` : ''),
  );
  if (skipped.length) {
    console.warn('건너뛴 행:', skipped);
  }
}

main();
