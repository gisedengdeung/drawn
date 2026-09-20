import type { DesignDraft } from '../../drawn-types';
import type {
  AgentMode,
  AgentResult,
  Evidence,
  Project,
  RunEvent,
  AgentProposal,
} from '../types';
import { createBomSnapshot } from '../../parts/bom';
import type { QuoteLine } from '../../parts/types';
import { searchParts } from '../../parts/server/search';
import { getPartsConfig } from '../../parts/server/config';
import { calculateOfferAmounts } from '../../parts/pricing';
import { estimateDraft } from '../../design-performance';
import {
  recommendDatasetCandidates,
  optimizeDraft,
  type DraftChange,
} from '../optimization';
import { searchKnowledge, getParameterInfo } from '../knowledge';
import { loadContext, showcases, asset } from './dataset';
import { hydrateDraft } from '../../design-draft';
import { isDesignDraft } from '../../design-gallery';
import { consumeBudget, isCancelled } from './store';
import { setting, type Bindings } from './env';
import { ApiError } from './http';
import { AgentModel } from './llm';

export type StoredProposal = {
  operation: AgentProposal['operation'];
  candidateDesignId?: number;
  changes?: DraftChange[];
  locks: string[];
};
export async function executeRun(args: {
  db: D1Database;
  env: Bindings;
  userId: string;
  runId: string;
  project: Project;
  mode: AgentMode;
  message: string;
  locks: string[];
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
}): Promise<AgentResult> {
  const { db, env, userId, runId, project, mode, message, signal, emit } = args;
  const evidence: Evidence[] = [],
    warnings: string[] = [],
    proposals: AgentProposal[] = [];
  const check = async () => {
    if (signal.aborted || (await isCancelled(db, userId, runId)))
      throw new ApiError(409, 'cancelled', '작업이 취소되었습니다.');
  };
  const charge = async (kind: 'tool' | 'llm' | 'provider') => {
    await check();
    await consumeBudget(db, userId, runId, kind);
  };
  const tool = async <T>(label: string, fn: () => Promise<T> | T) => {
    await charge('tool');
    emit({ type: 'progress', runId, message: label });
    return fn();
  };
  const context = await tool(
    '원본 설계와 현재 편집 내용을 확인하고 있습니다.',
    () => loadContext(env, project.draft),
  );
  const { index, selected, baseline } = context;
  const result: AgentResult = {
    answer: '',
    evidence,
    proposals,
    warnings,
    context: {
      projectId: project.id,
      revision: project.revision,
      fingerprint: project.fingerprint,
    },
  };
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({ selected, baseline })),
  );
  result.context.datasetVersion =
    'aircraftverse-' +
    Array.from(new Uint8Array(hash).slice(0, 8), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  const model = setting(env, 'OPENAI_API_KEY')
    ? new AgentModel(env, () => charge('llm'), signal)
    : null;
  const config = getPartsConfig(
    Object.fromEntries(
      [
        'ALIEXPRESS_APP_KEY',
        'ALIEXPRESS_APP_SECRET',
        'ALIEXPRESS_TRACKING_ID',
        'ALIEXPRESS_ACCESS_TOKEN',
        'ALIEXPRESS_DS_ENABLED',
        'ALIEXPRESS_TOP_REGION',
        'OPENAI_API_KEY',
        'PARTS_OPENAI_MODEL',
      ].map((name) => [name, setting(env, name)]),
    ),
  );
  const add = (entry: Omit<Evidence, 'id'>) => {
    const value = { ...entry, id: 'e' + (evidence.length + 1) };
    evidence.push(value);
    return value;
  };
  add({
    kind: 'dataset-output',
    title: '기준 설계 #' + selected.id,
    text: JSON.stringify({
      designId: selected.id,
      topology: selected.hub,
      massKg: selected.mass,
      rangeM: selected.maxDistance,
      hoverSeconds: selected.hoverTime,
      powerW: selected.power,
      maxSpeedMps: selected.maxSpeed,
      dragAt20N: selected.dragAt20,
    }),
    target: { view: 'explore', designId: selected.id },
  });
  const estimate = await tool(
    '원본 값과 편집 설계의 추정값을 구분하고 있습니다.',
    () => estimateDraft(selected, project.draft, baseline, index.designs),
  );
  add({
    kind: estimate.source === 'dataset' ? 'dataset-output' : 'draft-estimate',
    title: '현재 설계 · ' + estimate.modelVersion,
    text: JSON.stringify(estimate),
    target: { view: 'lab', designId: selected.id },
  });
  warnings.push(
    '원본 성능은 데이터셋 시뮬레이션이며, 편집 성능은 인접 설계 추정입니다. 실제 제작·비행 검증이 아닙니다.',
  );
  const quoteFor = async (draft: DesignDraft) => {
    const snapshot = createBomSnapshot(draft);
    const lines: QuoteLine[] = snapshot.items.map((item) => ({
      item,
      result: null,
      selectedOfferId: null,
    }));
    const current = draft === project.draft;
    if (current) result.quote = { snapshot, lines };
    await charge('tool');
    for (let offset = 0; offset < lines.length; offset += 2) {
      await check();
      emit({
        type: 'progress',
        runId,
        message:
          '설계 #' +
          draft.baselineId +
          ' 부품 ' +
          Math.min(offset + 2, lines.length) +
          '/' +
          lines.length +
          ' 조회 중',
      });
      await Promise.all(
        lines.slice(offset, offset + 2).map(async (line) => {
          try {
            line.result = await searchParts(
              { item: line.item, country: 'KR', currency: 'KRW' },
              {
                config,
                signal,
                allowAI: false,
                consumeBudget: async (kind) => {
                  await charge(kind === 'ai' ? 'llm' : 'provider');
                },
              },
            );
            const exact = line.result.offers.find(
              (offer) =>
                offer.match === 'exact' &&
                calculateOfferAmounts(line.item, offer).subtotal !== null,
            );
            line.selectedOfferId = exact?.id ?? null;
          } catch {
            line.result = {
              itemId: line.item.id,
              status: 'error',
              offers: [],
              warnings: ['조회 한도 또는 연결 상태를 확인해 주세요.'],
              retrievedAt: new Date().toISOString(),
            };
          }
        }),
      );
      if (current)
        await db
          .prepare(
            "UPDATE agent_runs SET result_json=?,updated_at=? WHERE id=? AND user_id=? AND status='running' AND cancel_requested=0 AND lease_until>?",
          )
          .bind(
            JSON.stringify({
              ...result,
              answer: '부품 조회 중 저장된 결과입니다.',
            }),
            new Date().toISOString(),
            runId,
            userId,
            Date.now(),
          )
          .run();
    }
    return { snapshot, lines };
  };
  const quoteEvidence = (
    quote: NonNullable<AgentResult['quote']>,
    title: string,
  ) => {
    const entries = quote.lines.map((line) => ({
      model: line.item.model,
      quantity: line.item.quantity,
      status: line.result?.status ?? 'unavailable',
      selectedOfferId: line.selectedOfferId,
      offers:
        line.result?.offers
          .filter((o, i) => i < 2 || o.id === line.selectedOfferId)
          .map((o) => ({
            id: o.id,
            selected: o.id === line.selectedOfferId,
            productId: o.productId,
            title: o.title,
            price: o.packPrice,
            currency: o.currency,
            priceKind: o.priceKind ?? 'listing',
            url: o.url,
            promotionUrl: o.promotionUrl,
            optionVerified: o.optionVerified,
            packQuantity: o.packQuantity,
            retrievedAt: o.retrievedAt,
          })) ?? [],
    }));
    add({
      kind: 'supplier-offer',
      title,
      text: JSON.stringify({
        designId: quote.snapshot.designId,
        fingerprint: quote.snapshot.fingerprint,
        scope: quote.snapshot.exclusions,
        entries,
      }),
      target: { view: 'parts', designId: quote.snapshot.designId },
    });
  };
  if (mode === 'parts') {
    result.quote = await quoteFor(project.draft);
    quoteEvidence(result.quote, '현재 설계의 AliExpress 조회 결과');
    const found = result.quote.lines.filter(
        (l) => l.result?.offers.length,
      ).length,
      total = result.quote.lines.length;
    result.answer =
      total +
      '종류 중 ' +
      found +
      '종류의 상품 후보를 확인했습니다. 표시가격과 링크는 부품 화면에서 확인할 수 있습니다. 옵션·묶음 수량이 미확인인 상품은 확정 합계에 포함하지 않습니다.';
    const statuses = new Set(result.quote.lines.map((l) => l.result?.status));
    if (statuses.has('not_configured'))
      warnings.push('AliExpress App Key와 App Secret 설정이 필요합니다.');
    if (statuses.has('permission_denied'))
      warnings.push('AliExpress 앱의 API 권한을 확인해 주세요.');
    if ([...statuses].some((s) => s !== 'ok' && s !== 'not_found'))
      warnings.push(
        '일부 부품 조회를 완료하지 못했습니다. 완료된 결과는 보존했습니다.',
      );
  } else {
    if (!model)
      throw new ApiError(
        503,
        'not_configured',
        'OpenAI API 설정이 필요합니다.',
      );
    const intent = await model.intent(message);
    if (mode === 'optimize') {
      const locks = args.locks;
      const options = {
        objective: intent.objective,
        massLimit: intent.massLimit ?? undefined,
        powerLimit: intent.powerLimit ?? undefined,
        topologyLocked: intent.topologyLocked,
        lockedParameterIds: locks,
      };
      const ranked = await tool(
        '조건에 맞는 데이터셋 후보를 비교하고 있습니다.',
        () => recommendDatasetCandidates(index.designs, selected, options),
      );
      const draftResults = await tool(
        '잠금을 유지하며 제한된 치수 변경안을 비교하고 있습니다.',
        () =>
          optimizeDraft({
            selected,
            baseline,
            draft: project.draft,
            designs: index.designs,
            ...options,
          }),
      );
      const persist = async (
        proposal: AgentProposal,
        payload: StoredProposal,
      ) => {
        await check();
        await db
          .prepare(
            "INSERT INTO agent_proposals(id,user_id,project_id,run_id,revision,fingerprint,operation,payload_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,'proposed',?)",
          )
          .bind(
            proposal.id,
            userId,
            project.id,
            runId,
            project.revision,
            project.fingerprint,
            proposal.operation,
            JSON.stringify(payload),
            new Date().toISOString(),
          )
          .run();
        proposals.push(proposal);
      };
      for (const candidate of ranked.candidates) {
        const reason =
          '원본 시뮬레이션 KPI·' +
          intent.objective +
          ' 목표와 질량/전력 제약으로 선정한 새 기준 설계입니다.';
        const proposal: AgentProposal = {
          id: crypto.randomUUID(),
          title: '기준 설계 #' + candidate.id + ' 선택',
          operation: 'select_dataset_design',
          candidateDesignId: candidate.id,
          changes: [],
          metrics: {
            mass: candidate.mass,
            range: candidate.maxDistance,
            hover: candidate.hoverTime,
            power: candidate.power,
            maxSpeed: candidate.maxSpeed,
          },
          reason,
        };
        await persist(proposal, {
          operation: proposal.operation,
          candidateDesignId: candidate.id,
          locks: [],
        });
        add({
          kind: 'dataset-output',
          title: proposal.title,
          text: JSON.stringify({
            candidate: proposal.metrics,
            constraints: ranked.constraints,
            score: candidate.score,
            reason,
          }),
          target: { view: 'explore', designId: candidate.id },
        });
      }
      for (const draftProposal of draftResults.proposals) {
        const proposal: AgentProposal = {
          id: crypto.randomUUID(),
          title:
            draftProposal.changes.map((c) => c.label).join(', ') + ' 변경안',
          operation: 'patch_draft',
          changes: draftProposal.changes.map((c) => ({
            targetId: c.id,
            before: c.before,
            after: c.after,
            unit: c.unit,
          })),
          metrics: {
            mass: draftProposal.after.mass,
            range: draftProposal.after.range,
            hover: draftProposal.after.hover,
            power: draftProposal.after.power,
            maxSpeed: draftProposal.after.maxSpeed,
          },
          reason:
            '인접 설계 추정 기준 목표 개선 ' +
            (draftProposal.improvement * 100).toFixed(2) +
            '%. ' +
            draftResults.reason,
        };
        await persist(proposal, {
          operation: proposal.operation,
          changes: draftProposal.changes,
          locks,
        });
        add({
          kind: 'draft-estimate',
          title: proposal.title,
          text: JSON.stringify({
            changes: proposal.changes,
            before: draftProposal.before,
            after: draftProposal.after,
          }),
          target: { view: 'lab', designId: selected.id },
        });
      }
      warnings.push(...draftResults.assumptions);
      if (!draftResults.proposals.length) warnings.push(draftResults.reason);
      if (intent.compareCost) {
        result.quote = await quoteFor(project.draft);
        quoteEvidence(result.quote, '현재 설계 견적');
        for (const candidate of ranked.candidates) {
          const shard = await tool(
            '비교 후보의 실제 부품 구성을 확인하고 있습니다.',
            () =>
              asset<Record<string, unknown>>(
                env,
                '/data/design-trees/shard-' +
                  String(Math.floor(candidate.id / 1000)).padStart(3, '0') +
                  '.json',
              ),
          );
          const raw = shard[String(candidate.id)];
          if (isDesignDraft(raw)) {
            try {
              quoteEvidence(
                await quoteFor(hydrateDraft(raw)),
                '후보 #' + candidate.id + ' 부품 비교',
              );
            } catch {
              warnings.push(
                '후보 #' + candidate.id + ' 비용 비교를 완료하지 못했습니다.',
              );
            }
          }
        }
        warnings.push(
          '확정 옵션·동일 범위의 가격이 없는 후보는 비용 우위로 평가하지 않았습니다. 상품 표시가격은 확정 구매비가 아닙니다.',
        );
      }
    } else {
      const bom = await tool(
        '현재 부품 구성과 문서 근거를 확인하고 있습니다.',
        () => createBomSnapshot(project.draft),
      );
      add({
        kind: 'user-input',
        title: '현재 편집 설계의 부품 구성',
        text: JSON.stringify(bom),
        target: { view: 'parts', designId: selected.id },
      });
      const info = getParameterInfo(project.draft, message);
      for (const parameter of info)
        add({
          kind: 'user-input',
          title: parameter.label,
          text: JSON.stringify(parameter),
          target: {
            view: 'lab',
            designId: selected.id,
            parameterId: parameter.id,
          },
        });
      const sections = searchKnowledge(message);
      for (const section of sections)
        add({
          kind: 'document',
          title: section.title + ' · ' + section.path + ' / ' + section.section,
          text: section.text + ' (문서 ' + section.version + ')',
        });
      if (intent.speed !== null) {
        const data = await tool(
          '해당 설계의 원본 속도별 trim을 확인하고 있습니다.',
          () => showcases(env),
        );
        const trim = data[String(selected.id)]?.trim.find(
          (row) => row.speed === intent.speed,
        );
        add({
          kind: 'dataset-trim',
          title: '원본 #' + selected.id + ' · ' + intent.speed + ' m/s',
          text: trim
            ? JSON.stringify(trim)
            : '이 설계·속도의 공개 원본 trim이 없습니다. 다른 설계의 곡선으로 대체하지 않습니다.',
          target: { view: 'simulator', designId: selected.id },
        });
      }
      const saved = await tool(
        '이 프로젝트에 저장된 최근 견적을 확인하고 있습니다.',
        () =>
          db
            .prepare(
              'SELECT quote_json FROM agent_quotes WHERE project_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1',
            )
            .bind(project.id, userId)
            .first<{ quote_json: string }>(),
      );
      if (saved) {
        const quote = JSON.parse(saved.quote_json) as NonNullable<
          AgentResult['quote']
        >;
        quoteEvidence(
          quote,
          quote.snapshot.fingerprint === project.fingerprint
            ? '저장된 현재 견적'
            : '저장된 이전 설계 견적',
        );
      }
    }
    try {
      result.answer = await model.explain(message, evidence, warnings);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'cancelled') throw error;
      result.answer =
        mode === 'optimize'
          ? proposals.length +
            '개의 비교안이 준비되었습니다. 아래 근거와 변경 내용을 확인한 뒤 적용하세요.'
          : '아래에 현재 설계에서 확인한 근거를 정리했습니다.';
      warnings.push(
        '자연어 설명을 완성하지 못해 확인된 계산·조회 결과를 표시합니다.',
      );
    }
  }
  await check();
  result.warnings = [...new Set(warnings)];
  return result;
}
