'use client';

import { useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  History,
  LoaderCircle,
  LogIn,
  MessageCircle,
  RotateCcw,
  Save,
  Send,
  ShoppingBag,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AgentWorkspaceController } from '@/hooks/use-agent-workspace';
import type {
  AgentMode,
  AgentProposal,
  AgentResult,
  Evidence,
} from '@/lib/agent/types';
import type { DesignDraft } from '@/lib/drawn-types';
import {
  affiliatePromotionLink,
  canonicalProductLink,
} from '@/lib/parts/links';

const modes = [
  {
    id: 'parts' as const,
    label: '부품 찾기',
    icon: ShoppingBag,
    hint: '현재 설계의 모터·프로펠러·배터리·서보 가격과 구매 링크를 찾습니다.',
    placeholder: '예: 이 설계에 들어가는 부품과 가격을 찾아줘',
  },
  {
    id: 'optimize' as const,
    label: '설계 개선',
    icon: SlidersHorizontal,
    hint: '목표와 제한을 적으면 비교 가능한 개선안을 제안합니다. 적용은 직접 선택합니다.',
    placeholder: '예: 현재 구조를 유지하고 체공시간을 늘려줘. 최대 질량은 10kg',
  },
  {
    id: 'qa' as const,
    label: '질문하기',
    icon: MessageCircle,
    hint: '설계 데이터와 문서에 근거해 설명합니다. 편집 설계의 성능은 추정값입니다.',
    placeholder:
      '예: 이 설계의 항속거리는 어떤 값이야? 팔 길이를 바꾸면 어떻게 돼?',
  },
];
const statusLabel: Record<string, string> = {
  running: '진행 중',
  completed: '완료',
  partial: '일부 완료',
  failed: '실패',
  cancelled: '취소',
};
const evidenceLabel: Record<Evidence['kind'], string> = {
  'dataset-output': '원본 시뮬레이션',
  'dataset-trim': '원본 trim',
  'draft-estimate': '편집 설계 추정',
  'supplier-offer': '판매처 조회',
  document: '프로젝트 문서',
  'user-input': '설계 입력',
};
const fieldClass =
  'w-full rounded-lg border border-[#ccd8df] bg-white px-3 py-2 text-sm text-[#172b3a] outline-none focus:border-[#147d91] focus:ring-2 focus:ring-[#147d91]/15 disabled:opacity-60';

export function DesignAssistant({
  open,
  onOpenChange,
  mode,
  onModeChange,
  controller,
  draft,
  onNavigate,
  onCompare,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  controller: AgentWorkspaceController;
  draft: DesignDraft | null;
  onNavigate: (target: NonNullable<Evidence['target']>) => void;
  onCompare: (designId: number) => void;
}) {
  const mobile = useIsMobile();
  const content = (
    <AssistantContent
      mode={mode}
      onModeChange={onModeChange}
      controller={controller}
      draft={draft}
      onNavigate={onNavigate}
      onCompare={onCompare}
    />
  );
  if (mobile)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] rounded-t-2xl border-[#dbe4ea] bg-[#f7f9fb] text-[#172b3a]"
        >
          <SheetHeader className="border-b border-[#dbe4ea] pb-3">
            <SheetTitle className="flex items-center gap-2 text-[#172b3a]">
              <Bot className="size-5 text-[#147d91]" />
              설계 도우미
            </SheetTitle>
            <SheetDescription className="text-[#607383]">
              현재 설계에서 부품 찾기, 설계 개선, 질문까지
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-y-auto px-4 pb-5">{content}</div>
        </SheetContent>
      </Sheet>
    );
  if (!open) return null;
  return (
    <aside
      aria-label="설계 도우미"
      className="sticky top-[103px] flex h-[calc(100dvh-103px)] w-[390px] shrink-0 flex-col border-l border-[#dbe4ea] bg-[#f7f9fb]"
    >
      <div className="flex items-start justify-between border-b border-[#dbe4ea] p-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Bot className="size-5 text-[#147d91]" />
            설계 도우미
          </h2>
          <p className="mt-1 text-xs text-[#607383]">
            현재 설계의 근거를 함께 확인하세요.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="설계 도우미 닫기"
          onClick={() => onOpenChange(false)}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{content}</div>
    </aside>
  );
}

function AssistantContent({
  mode,
  onModeChange,
  controller: agent,
  draft,
  onNavigate,
  onCompare,
}: {
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  controller: AgentWorkspaceController;
  draft: DesignDraft | null;
  onNavigate: (target: NonNullable<Evidence['target']>) => void;
  onCompare: (designId: number) => void;
}) {
  const [message, setMessage] = useState('');
  const [locks, setLocks] = useState<string[]>([]);
  const [pendingProjectId, setPendingProjectId] = useState('');
  const currentMode = modes.find((item) => item.id === mode)!;
  const blocked = agent.running || agent.busy;
  const quotaReached =
    !!agent.session?.usage &&
    (agent.session.usage.used >= agent.session.usage.limit ||
      agent.session.usage.globalRemaining <= 0);
  const canRun =
    !!draft &&
    !!agent.session?.user &&
    !blocked &&
    !quotaReached &&
    (mode !== 'qa' || message.trim().length > 0);
  const quote = agent.result?.quote;
  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun) return;
    void agent.run(
      mode,
      message.trim() ||
        (mode === 'parts'
          ? '현재 설계의 부품 가격과 구매 링크를 찾아줘.'
          : '현재 설계의 체공시간을 개선해줘.'),
      locks,
    );
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-xl border border-[#dbe4ea] bg-white p-3">
        {agent.sessionLoading ? (
          <output className="flex items-center gap-2 text-xs text-[#607383]">
            <LoaderCircle className="size-4 animate-spin" />
            로그인 상태 확인 중
          </output>
        ) : agent.session?.user ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">
                {agent.session.user.name || agent.session.user.email}
              </span>
              <button
                className="shrink-0 text-xs text-[#607383] underline"
                disabled={blocked}
                onClick={() => void agent.signOut()}
              >
                로그아웃
              </button>
            </div>
            {agent.session.usage && (
              <p className="mt-2 text-xs text-[#607383]">
                오늘 {agent.session.usage.used}/{agent.session.usage.limit}회
                사용 · 무료 이용
                <span className="block pt-1">
                  다음 초기화:{' '}
                  {new Date(agent.session.usage.resetAt).toLocaleString(
                    'ko-KR',
                  )}
                </span>
              </p>
            )}
            {quotaReached && (
              <p className="mt-2 text-xs text-amber-800">
                오늘 이용 가능한 횟수를 모두 사용했습니다. 저장된 결과는 계속 볼
                수 있습니다.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="font-medium">
              설계를 저장하고 도우미와 이어서 작업하세요.
            </p>
            <p className="mt-1 text-xs leading-5 text-[#607383]">
              Google 로그인 후 무료 일일 한도 안에서 이용할 수 있습니다.
            </p>
            {agent.session?.configured ? (
              <Button
                onClick={() => void agent.signIn()}
                disabled={blocked}
                className="mt-3 w-full bg-[#147d91] text-white hover:bg-[#0f6475]"
              >
                <LogIn />
                Google로 로그인
              </Button>
            ) : (
              <div className="mt-3 rounded-lg bg-[#fff8e8] p-2.5 text-xs leading-5 text-amber-900">
                로그인 서비스 설정을 준비하고 있습니다. 현재 설계 탐색과 편집은
                계속 이용할 수 있습니다.
              </div>
            )}
          </>
        )}
      </div>

      {agent.session?.user && (
        <div className="space-y-2 rounded-xl border border-[#dbe4ea] bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">내 프로젝트</p>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="프로젝트와 실행 기록 새로고침"
              disabled={blocked}
              onClick={() => void agent.refresh()}
            >
              <RotateCcw />
            </Button>
          </div>
          <select
            aria-label="내 프로젝트 선택"
            className={fieldClass}
            value={pendingProjectId}
            disabled={blocked}
            onChange={(event) => setPendingProjectId(event.target.value)}
          >
            <option value="">저장된 프로젝트 선택</option>
            {agent.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title} · v{project.revision}
              </option>
            ))}
          </select>
          {pendingProjectId && (
            <div className="rounded-lg bg-[#eef8fa] p-2.5 text-xs text-[#0f6475]">
              <p>
                불러오면 현재 편집 화면이 바뀝니다. 남길 편집은 먼저 새
                프로젝트로 저장하세요.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={blocked}
                onClick={() => void agent.loadProject(pendingProjectId)}
              >
                선택한 프로젝트 불러오기
              </Button>
            </div>
          )}
          {agent.project ? (
            <p className="text-xs text-[#607383]">
              {agent.project.title} · v{agent.project.revision} ·{' '}
              {agent.dirty ? '저장하지 않은 변경' : '저장됨'}
            </p>
          ) : (
            <p className="text-xs text-[#607383]">
              현재 브라우저의 편집본을 개인 프로젝트로 가져옵니다.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || !draft || (!!agent.project && !agent.dirty)}
              onClick={() => void agent.save(false)}
            >
              <Save />
              {agent.project ? '변경 저장' : '내 프로젝트로 가져오기'}
            </Button>
            {agent.project && (
              <Button
                size="sm"
                variant="ghost"
                disabled={blocked || !draft}
                onClick={() => void agent.save(true)}
              >
                새 프로젝트로 저장
              </Button>
            )}
          </div>
        </div>
      )}

      <div>
        <fieldset
          aria-label="도우미 작업 선택"
          className="grid grid-cols-3 gap-1 rounded-xl border border-[#dbe4ea] bg-white p-1"
        >
          {modes.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={mode === item.id}
              disabled={agent.running}
              onClick={() => onModeChange(item.id)}
              className={`flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs font-medium transition ${mode === item.id ? 'bg-[#147d91] text-white' : 'text-[#607383] hover:bg-[#eef8fa]'}`}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </fieldset>
        <p className="mt-2 text-xs leading-5 text-[#607383]">
          {currentMode.hint}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-2">
        <label htmlFor="agent-message" className="block text-xs font-medium">
          {mode === 'qa'
            ? '설계에 대해 궁금한 점'
            : mode === 'optimize'
              ? '설계 목표와 제한 조건'
              : '찾을 부품과 요청 사항'}
        </label>
        <textarea
          id="agent-message"
          rows={3}
          maxLength={2000}
          className={`${fieldClass} resize-y`}
          placeholder={currentMode.placeholder}
          value={message}
          disabled={agent.running}
          onChange={(event) => setMessage(event.target.value)}
        />
        {mode === 'optimize' && draft && (
          <details className="rounded-lg border border-[#dbe4ea] bg-white p-2.5">
            <summary className="cursor-pointer text-xs font-medium">
              변경하지 않을 파라미터 선택 ({locks.length})
            </summary>
            <p className="my-2 text-xs text-[#607383]">
              탑재중량·부품 구성·기체 구조는 기본으로 유지합니다.
            </p>
            <div className="space-y-2">
              {[
                { id: 'structure', label: '팔 길이' },
                { id: 'fuselage', label: '동체 치수' },
                { id: 'wing', label: '날개 span / chord' },
              ].map((item) => (
                <label key={item.id} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    disabled={blocked}
                    checked={locks.includes(item.id)}
                    onChange={(event) =>
                      setLocks((current) =>
                        event.target.checked
                          ? [...current, item.id]
                          : current.filter((id) => id !== item.id),
                      )
                    }
                    className="mt-0.5 accent-[#147d91]"
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>
          </details>
        )}
        <p className="text-[11px] text-[#607383]">
          {draft
            ? `Design #${draft.baselineId} · 실행 전에 현재 편집본을 저장합니다.`
            : '설계 데이터를 불러오는 중입니다.'}
        </p>
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={!canRun}
            className="flex-1 bg-[#147d91] text-white hover:bg-[#0f6475]"
          >
            {agent.running ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Send />
            )}
            {agent.running ? '진행 중' : `${currentMode.label} 실행`}
          </Button>
          {agent.running && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void agent.cancel()}
            >
              <Square />
              취소
            </Button>
          )}
        </div>
      </form>

      {agent.error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-5 text-rose-900"
        >
          {agent.error}
          <button
            type="button"
            className="mt-2 block underline"
            disabled={blocked}
            onClick={() => void agent.refresh()}
          >
            상태와 실행 기록 다시 확인
          </button>
        </div>
      )}
      {agent.progress.length > 0 && (
        <output
          aria-live="polite"
          className="rounded-lg border border-[#dbe4ea] bg-white p-3"
        >
          <p className="mb-2 text-xs font-semibold">실행 진행</p>
          <ol className="space-y-1 text-xs leading-5 text-[#607383]">
            {agent.progress.map((line, index) => (
              <li key={`${index}-${line}`} className="flex gap-2">
                <span aria-hidden="true">
                  {index === agent.progress.length - 1 && agent.running
                    ? '◌'
                    : '·'}
                </span>
                {line}
              </li>
            ))}
          </ol>
        </output>
      )}

      {agent.result && (
        <div className="space-y-3">
          <div className="rounded-xl border border-[#bddde3] bg-white p-3">
            <p className="mb-2 text-xs font-semibold text-[#0f6475]">
              답변 · 설계 v{agent.result.context.revision}
            </p>
            {agent.stale && (
              <p className="mb-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                이전 설계 기준의 결과입니다. 현재 설계로 다시 실행해야 변경안을
                적용할 수 있습니다.
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm leading-6">
              {agent.result.answer}
            </p>
          </div>
          {agent.result.warnings.map((warning, index) => (
            <p
              key={`${index}-${warning}`}
              className="rounded-lg bg-amber-50 p-2.5 text-xs leading-5 text-amber-900"
            >
              {warning}
            </p>
          ))}
          {quote && (
            <div className="rounded-xl border border-[#dbe4ea] bg-white p-3">
              <p className="font-medium">부품 견적 {quote.lines.length}종</p>
              <p className="mt-1 text-xs leading-5 text-[#607383]">
                모터·프로펠러·배터리·서보 범위입니다. 옵션과 배송비가 확인되지
                않은 표시는 확정 합계에 포함되지 않습니다.
              </p>
              <Button
                className="mt-2"
                variant="outline"
                size="sm"
                onClick={() => onNavigate({ view: 'parts' })}
              >
                <ShoppingBag />
                구매표와 CSV 보기
              </Button>
            </div>
          )}
          {agent.result.proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              disabled={blocked || agent.stale}
              onApply={() => void agent.apply(proposal.id)}
              onCompare={onCompare}
            />
          ))}
          {agent.canUndo && (
            <Button
              className="w-full"
              variant="outline"
              disabled={blocked}
              onClick={() => void agent.undo()}
            >
              <RotateCcw />
              적용 전 설계로 되돌리기
            </Button>
          )}
          <EvidenceList result={agent.result} onNavigate={onNavigate} />
        </div>
      )}

      {agent.runs.length > 0 && (
        <details className="rounded-xl border border-[#dbe4ea] bg-white p-3">
          <summary className="cursor-pointer text-xs font-semibold">
            <History className="mr-1 inline size-3.5" />이 프로젝트의 실행 기록
            ({agent.runs.length})
          </summary>
          <ul className="mt-3 space-y-2">
            {agent.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  disabled={blocked || !run.result}
                  onClick={() => agent.selectRun(run)}
                  className="w-full rounded-lg border border-[#e3e9ee] p-2 text-left hover:bg-[#eef8fa] disabled:opacity-60"
                >
                  <span className="block text-xs font-medium">
                    {modes.find((item) => item.id === run.mode)?.label} · v
                    {run.revision} · {statusLabel[run.status] ?? run.status}
                  </span>
                  <span className="mt-1 block truncate text-xs text-[#607383]">
                    {run.message}
                  </span>
                  <span className="mt-1 block text-[10px] text-[#607383]">
                    {new Date(run.createdAt).toLocaleString('ko-KR')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  disabled,
  onApply,
  onCompare,
}: {
  proposal: AgentProposal;
  disabled: boolean;
  onApply: () => void;
  onCompare: (designId: number) => void;
}) {
  return (
    <article className="rounded-xl border border-[#dbe4ea] bg-white p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#147d91]">
        {proposal.operation === 'select_dataset_design'
          ? '다른 설계를 새 기준으로 선택'
          : '현재 설계의 파라미터 개선'}
      </p>
      <h3 className="mt-1 font-semibold">{proposal.title}</h3>
      <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[#607383]">
        {proposal.reason}
      </p>
      {proposal.changes.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#dbe4ea] text-[#607383]">
                <th className="pb-1 font-medium">변경 항목</th>
                <th className="pb-1 font-medium">현재</th>
                <th className="pb-1 font-medium">제안</th>
              </tr>
            </thead>
            <tbody>
              {proposal.changes.map((change) => (
                <tr key={change.targetId} className="border-b border-[#eef2f5]">
                  <td className="max-w-36 break-words py-2 pr-2">
                    {changeLabel(change.targetId)}
                  </td>
                  <td className="py-2 pr-2">
                    {change.before.toLocaleString()} {change.unit}
                  </td>
                  <td className="py-2 text-[#0f6475]">
                    {change.after.toLocaleString()} {change.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {proposal.metrics && (
        <div className="mt-3">
          <MetricFacts data={proposal.metrics} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled}
          onClick={onApply}
          className="bg-[#147d91] text-white hover:bg-[#0f6475]"
        >
          <Check />
          {proposal.operation === 'select_dataset_design'
            ? '이 설계로 변경'
            : '변경안 적용'}
        </Button>
        {proposal.candidateDesignId != null && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCompare(proposal.candidateDesignId!)}
          >
            기준 설계와 비교
          </Button>
        )}
      </div>
    </article>
  );
}

function EvidenceList({
  result,
  onNavigate,
}: {
  result: AgentResult;
  onNavigate: (target: NonNullable<Evidence['target']>) => void;
}) {
  if (result.evidence.length === 0) return null;
  return (
    <details className="rounded-xl border border-[#dbe4ea] bg-white p-3" open>
      <summary className="cursor-pointer text-xs font-semibold">
        답변의 근거 ({result.evidence.length})
      </summary>
      <ul className="mt-3 space-y-3">
        {result.evidence.map((evidence) => (
          <li
            id={`agent-evidence-${evidence.id}`}
            key={evidence.id}
            className="scroll-mt-4 border-t border-[#eef2f5] pt-2"
          >
            <span className="text-[10px] font-medium text-[#147d91]">
              [{evidence.id}] · {evidenceLabel[evidence.kind]}
            </span>
            <p className="mt-1 text-xs font-semibold">{evidence.title}</p>
            <div className="mt-2 text-xs leading-5 text-[#607383]">
              <EvidenceFacts text={evidence.text} />
            </div>
            {evidence.target && (
              <button
                type="button"
                onClick={() => onNavigate(evidence.target!)}
                className="mt-2 inline-flex items-center text-xs font-medium text-[#0f6475]"
              >
                관련{' '}
                {evidence.target.view === 'lab'
                  ? '파라미터'
                  : evidence.target.view === 'parts'
                    ? '부품'
                    : evidence.target.view === 'simulator'
                      ? '성능'
                      : '설계'}{' '}
                보기
                <ChevronRight className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

type FactRecord = Record<string, unknown>;
const factRecord = (value: unknown): value is FactRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const factRecords = (value: unknown): FactRecord[] =>
  Array.isArray(value) ? value.filter(factRecord).slice(0, 20) : [];
const factStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 12)
    : [];
const factText = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const factNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const numberText = (value: number) =>
  value.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
const dateText = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('ko-KR')
    : '조회 시각 미확인';
const metricLabels: Record<
  string,
  { label: string; unit: string; negative?: boolean }
> = {
  massKg: { label: '질량', unit: 'kg' },
  mass: { label: '질량', unit: 'kg' },
  rangeM: { label: '최대 비행거리', unit: 'm' },
  range: { label: '최대 비행거리', unit: 'm' },
  distance: { label: '비행거리', unit: 'm' },
  hoverSeconds: { label: '체공시간', unit: 's' },
  hover: { label: '체공시간', unit: 's' },
  flightTime: { label: '비행시간', unit: 's' },
  powerW: { label: '전력', unit: 'W' },
  power: { label: '전력', unit: 'W' },
  maxSpeedMps: { label: '최대 속도', unit: 'm/s' },
  maxSpeed: { label: '최대 속도', unit: 'm/s' },
  speed: { label: '속도', unit: 'm/s' },
  dragAt20N: { label: '20 m/s 항력', unit: 'N' },
  drag: { label: '항력', unit: 'N' },
  pitch: { label: '피치각', unit: '°', negative: true },
  thrust: { label: '추력', unit: 'N' },
  lift: { label: '양력', unit: 'N' },
  current: { label: '전류', unit: 'A' },
  maxUc: { label: '최대 제어 입력', unit: '' },
  motorCurrentRatio: { label: '모터 전류 비율', unit: '' },
  motorPowerRatio: { label: '모터 전력 비율', unit: '' },
  batteryCurrentRatio: { label: '배터리 전류 비율', unit: '' },
};

function metricRows(data: FactRecord) {
  const validity = factRecord(data.fieldValidity) ? data.fieldValidity : {};
  return Object.entries(metricLabels)
    .filter(([key]) => Object.hasOwn(data, key))
    .map(([key, detail]) => {
      const value = factNumber(data[key]);
      return {
        key,
        label: detail.label,
        value:
          value === null ||
          validity[key] === false ||
          (!detail.negative && value < 0)
            ? '확인값 없음'
            : `${numberText(value)} ${detail.unit}`.trim(),
      };
    });
}

function MetricFacts({ data }: { data: FactRecord }) {
  const rows = metricRows(data);
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-2">
      {rows.map((row) => (
        <div key={row.key} className="rounded-md bg-[#f7f9fb] p-2">
          <dt className="text-[11px] text-[#607383]">{row.label}</dt>
          <dd className="mt-0.5 text-xs font-medium text-[#172b3a]">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function changeLabel(id: string) {
  const names: Record<string, string> = {
    'fuselage:length': '동체 길이',
    'fuselage:horizontalDiameter': '동체 가로 직경',
    'fuselage:verticalDiameter': '동체 세로 직경',
  };
  if (names[id]) return names[id];
  if (id.startsWith('segment:') && id.endsWith(':length')) return '팔 길이';
  if (id.startsWith('wing:'))
    return id.endsWith(':span')
      ? '날개 span'
      : id.endsWith(':chordInner')
        ? '날개 안쪽 chord'
        : id.endsWith(':chordOuter')
          ? '날개 바깥쪽 chord'
          : '날개 파라미터';
  return '설계 파라미터';
}

function EvidenceFacts({ text }: { text: string }) {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return (
      <p className="whitespace-pre-wrap">
        {text.trimStart().startsWith('{')
          ? '상세 근거는 관련 설계 화면에서 확인할 수 있습니다.'
          : text}
      </p>
    );
  }
  if (!factRecord(data))
    return (
      <p className="whitespace-pre-wrap">
        {typeof data === 'string'
          ? data
          : '상세 근거는 관련 설계 화면에서 확인할 수 있습니다.'}
      </p>
    );
  if (Array.isArray(data.entries)) return <SupplierFacts data={data} />;
  if (Array.isArray(data.items)) return <BomFacts data={data} />;
  if (typeof data.label === 'string' && Object.hasOwn(data, 'value'))
    return <ParameterFacts data={data} />;
  if (factRecord(data.before) && factRecord(data.after))
    return (
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#dbe4ea]">
                <th className="pb-1 font-medium">성능 추정</th>
                <th className="pb-1 font-medium">현재</th>
                <th className="pb-1 font-medium">변경 후</th>
              </tr>
            </thead>
            <tbody>
              {metricRows(data.before).map((row) => (
                <tr key={row.key} className="border-b border-[#eef2f5]">
                  <td className="py-1.5 pr-1">{row.label}</td>
                  <td className="py-1.5 pr-1">{row.value}</td>
                  <td className="py-1.5 text-[#0f6475]">
                    {metricRows(data.after as FactRecord).find(
                      (after) => after.key === row.key,
                    )?.value ?? '확인값 없음'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <EstimateDetails data={data.after} />
      </div>
    );
  const metrics = factRecord(data.candidate) ? data.candidate : data;
  const rows = metricRows(metrics);
  return (
    <div className="space-y-2">
      {factNumber(data.designId) !== null && (
        <p>
          기준 설계 #{String(data.designId)}
          {typeof data.topology === 'string' ? ` · ${data.topology}` : ''}
        </p>
      )}
      {data.valid === false && (
        <p className="text-amber-900">
          이 속도의 trim 해가 유효하지 않습니다. 확인 가능한 필드만 표시합니다.
        </p>
      )}
      <MetricFacts data={metrics} />
      <EstimateDetails data={data} />
      {factRecord(data.constraints) && (
        <p>
          조건:{' '}
          {factNumber(data.constraints.massLimit) !== null
            ? `질량 ${numberText(data.constraints.massLimit as number)} kg 이하`
            : '질량 한도 없음'}{' '}
          ·{' '}
          {factNumber(data.constraints.powerLimit) !== null
            ? `전력 ${numberText(data.constraints.powerLimit as number)} W 이하`
            : '전력 한도 없음'}
          {data.constraints.topologyLocked === true ? ' · 기체 구조 유지' : ''}
        </p>
      )}
      {typeof data.reason === 'string' && <p>{data.reason}</p>}
      {!rows.length &&
        !factRecord(data.constraints) &&
        typeof data.reason !== 'string' && (
          <p>상세 근거는 관련 설계 화면에서 확인할 수 있습니다.</p>
        )}
    </div>
  );
}

function ParameterFacts({ data }: { data: FactRecord }) {
  const value = factNumber(data.value);
  const unit = factText(data.unit);
  const range = factRecord(data.range) ? data.range : null;
  return (
    <div className="space-y-1">
      <p className="font-medium text-[#172b3a]">
        현재 값:{' '}
        {value !== null
          ? numberText(value)
          : typeof data.value === 'string'
            ? data.value
            : typeof data.value === 'boolean'
              ? data.value
                ? '사용'
                : '사용 안 함'
              : '확인값 없음'}{' '}
        {unit}
      </p>
      {range &&
        factNumber(range.min) !== null &&
        factNumber(range.max) !== null && (
          <p>
            편집 범위: {numberText(range.min as number)}–
            {numberText(range.max as number)} {unit}
          </p>
        )}
      <p>
        {data.editable === true ? '편집 가능' : '읽기 전용'}
        {data.affectsGeometry === true ? ' · 형상에 영향' : ''}
        {data.affectsPerformance === true ? ' · 성능 추정에 영향' : ''}
      </p>
      {typeof data.description === 'string' && <p>{data.description}</p>}
    </div>
  );
}

function EstimateDetails({ data }: { data: FactRecord }) {
  const neighbors = factRecords(data.neighbors);
  const corrections = factRecord(data.appliedCorrections)
    ? data.appliedCorrections
    : {};
  const correctionNames: Record<string, string> = {
    armRatio: '팔 길이 비',
    bodyRatio: '동체 크기 비',
    batteryRatio: '배터리 용량 비',
    wingRatio: '날개 면적 비',
    massRatio: '질량 비',
    layoutDragPenalty: '배치에 따른 항력 보정',
    dragFactor: '항력 보정 계수',
    efficiency: '효율 보정 계수',
    componentChanges: '변경된 부품 수',
  };
  const entries = Object.entries(correctionNames).filter(
    ([key]) => factNumber(corrections[key]) !== null,
  );
  if (!neighbors.length && !entries.length) return null;
  const totalWeight = neighbors.reduce(
    (sum, neighbor) => sum + Math.max(0, factNumber(neighbor.weight) ?? 0),
    0,
  );
  return (
    <details className="rounded-lg border border-[#e3e9ee] p-2">
      <summary className="cursor-pointer font-medium">
        {data.source === 'dataset'
          ? '원본 성능의 기준 설계'
          : '추정에 사용한 이웃과 보정'}
      </summary>
      {neighbors.length > 0 && (
        <ul className="mt-2 space-y-1">
          {neighbors.map((neighbor, index) => (
            <li key={String(factNumber(neighbor.designId) ?? index)}>
              설계 #{String(factNumber(neighbor.designId) ?? '미확인')}
              {factNumber(neighbor.distance) !== null
                ? ` · 설계 거리 ${numberText(neighbor.distance as number)}`
                : ''}
              {totalWeight > 0 && factNumber(neighbor.weight) !== null
                ? ` · 이웃 가중치 ${numberText(((neighbor.weight as number) / totalWeight) * 100)}%`
                : ''}
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 && (
        <dl className="mt-2 space-y-1">
          {entries.map(([key, label]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt>{label}</dt>
              <dd>{numberText(corrections[key] as number)}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.topologyFallbackUsed === true && (
        <p className="mt-2 text-amber-900">
          같은 기체 구조의 설계가 부족해 프로펠러 수와 날개 유무가 같은 설계로
          이웃 범위를 넓혔습니다.
        </p>
      )}
      {data.source !== 'dataset' && (
        <p className="mt-2">
          이웃 가중치는 설계 거리 기준입니다. 각 성능값은 유효한 이웃만 다시
          정규화하며, 정확도나 비행 안전 확률을 뜻하지 않습니다.
        </p>
      )}
      {factStrings(data.assumptions).some((note) =>
        note.includes('5000 mAh'),
      ) && (
        <p className="mt-1 text-amber-900">
          배터리 용량을 식별하지 못한 입력에는 기존 추정기의 5,000 mAh 기본값이
          사용되었습니다.
        </p>
      )}
      {factStrings(data.unsupportedInputs).length > 0 && (
        <p className="mt-1">
          제조사 부품 성능, 물리적 호환성, 실제 비행 인증은 검증 범위에 포함되지
          않습니다.
        </p>
      )}
    </details>
  );
}

function BomFacts({ data }: { data: FactRecord }) {
  const labels: Record<string, string> = {
    motor: '모터',
    propeller: '프로펠러',
    battery: '배터리',
    servo: '서보',
  };
  return (
    <div className="space-y-2">
      <p>
        설계 #{String(factNumber(data.designId) ?? '미확인')} ·
        모터·프로펠러·배터리·서보 범위
      </p>
      <ul className="space-y-1">
        {factRecords(data.items).map((item, index) => (
          <li key={factText(item.id) || String(index)}>
            {labels[factText(item.kind)] ?? '부품'} ·{' '}
            {factText(item.model) || '모델 미확인'} ·{' '}
            {factNumber(item.quantity) !== null
              ? `${String(item.quantity)}개`
              : '수량 미확인'}
          </li>
        ))}
      </ul>
      {factStrings(data.exclusions).map((note) => (
        <p key={note} className="text-amber-900">
          {note}
        </p>
      ))}
    </div>
  );
}

function SupplierFacts({ data }: { data: FactRecord }) {
  const labels: Record<string, string> = {
    ok: '조회 완료',
    not_found: '상품 없음',
    not_configured: '연동 설정 필요',
    permission_denied: 'API 권한 확인 필요',
    rate_limited: '조회 한도 도달',
    error: '조회 실패',
    unavailable: '미조회',
  };
  return (
    <div className="space-y-3">
      <p>
        설계 #{String(factNumber(data.designId) ?? '미확인')} · 네 종류 부품의
        조회 결과
      </p>
      {factRecords(data.entries).map((entry, index) => (
        <div
          key={`${factText(entry.model)}-${index}`}
          className="rounded-lg border border-[#e3e9ee] p-2"
        >
          <p className="font-medium text-[#172b3a]">
            {factText(entry.model) || '모델 미확인'} ·{' '}
            {factNumber(entry.quantity) !== null
              ? `${String(entry.quantity)}개`
              : '수량 미확인'}
          </p>
          <p className="text-[11px]">
            {labels[factText(entry.status)] ?? '결과 확인 필요'}
          </p>
          <ul className="mt-2 space-y-2">
            {factRecords(entry.offers).map((offer, offerIndex) => {
              const productId = factText(offer.productId);
              const canonical = canonicalProductLink(offer.url, productId);
              const promotion =
                affiliatePromotionLink(offer.promotionUrl, productId) ??
                affiliatePromotionLink(offer.url, productId);
              const price = factNumber(offer.price);
              const skuConfirmed =
                offer.priceKind === 'sku' && offer.optionVerified === true;
              return (
                <li
                  key={`${productId}-${offerIndex}`}
                  className="border-t border-[#eef2f5] pt-2"
                >
                  <p className="text-[#172b3a]">
                    {factText(offer.title) || '상품명 미확인'}
                  </p>
                  <p>
                    {skuConfirmed ? '옵션 가격' : '상품 표시가격'}:{' '}
                    {price === null || price < 0
                      ? '미확인'
                      : `${numberText(price)} ${factText(offer.currency)}`}
                  </p>
                  <p className="text-[11px]">
                    {skuConfirmed ? '옵션 확인됨' : '옵션 미확인'} ·{' '}
                    {factNumber(offer.packQuantity) !== null
                      ? `묶음 ${String(offer.packQuantity)}개`
                      : '묶음 수량 미확인'}
                  </p>
                  <p className="text-[10px]">
                    조회: {dateText(offer.retrievedAt)}
                  </p>
                  <div className="mt-1 flex gap-3">
                    {canonical && (
                      <a
                        href={canonical}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-[#0f6475] underline"
                      >
                        상품 링크
                      </a>
                    )}
                    {promotion && (
                      <a
                        href={promotion}
                        target="_blank"
                        rel="noopener noreferrer sponsored"
                        className="font-medium text-[#0f6475] underline"
                      >
                        제휴 링크
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p>
        옵션·묶음 수량·배송비가 확인되지 않은 표시가격은 확정 구매 합계가
        아닙니다.
      </p>
      {factStrings(data.scope).map((note) => (
        <p key={note} className="text-amber-900">
          {note}
        </p>
      ))}
    </div>
  );
}
