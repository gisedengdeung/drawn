import { z } from 'zod';
import { requireUser } from '../../../../../lib/agent/server/auth';
import {
  readJson,
  json,
  fail,
  ApiError,
} from '../../../../../lib/agent/server/http';
import { getProject } from '../../../../../lib/agent/server/store';
import { loadContext, asset } from '../../../../../lib/agent/server/dataset';
import { applyDraftChanges } from '../../../../../lib/agent/optimization';
import { draftFingerprint } from '../../../../../lib/parts/bom';
import { hydrateDraft } from '../../../../../lib/design-draft';
import { isDesignDraft } from '../../../../../lib/design-gallery';
import type { StoredProposal } from '../../../../../lib/agent/server/runner';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { db, user, env } = await requireUser(request),
      id = (await context.params).id;
    const input = z
      .object({ expectedRevision: z.number().int().positive() })
      .safeParse(await readJson(request, 4000));
    if (!input.success)
      throw new ApiError(400, 'invalid_input', '설계 버전을 확인해 주세요.');
    const row = await db
      .prepare(
        "SELECT p.* FROM agent_proposals p JOIN agent_runs r ON r.id=p.run_id WHERE p.id=? AND p.user_id=? AND r.status IN ('completed','partial')",
      )
      .bind(id, user.id)
      .first<{
        project_id: string;
        revision: number;
        fingerprint: string;
        payload_json: string;
        status: string;
      }>();
    if (!row)
      throw new ApiError(404, 'not_found', '완료된 변경안을 찾을 수 없습니다.');
    const project = await getProject(db, user.id, row.project_id);
    if (
      row.status !== 'proposed' ||
      project.revision !== input.data.expectedRevision ||
      project.revision !== row.revision ||
      project.fingerprint !== row.fingerprint
    )
      throw new ApiError(
        409,
        'stale_proposal',
        '이 변경안은 이미 적용되었거나 이전 설계 기준입니다. 다시 평가해 주세요.',
      );
    const payload = JSON.parse(row.payload_json) as StoredProposal;
    let draft = project.draft;
    if (payload.operation === 'select_dataset_design') {
      const candidateId = payload.candidateDesignId!;
      const shard = await asset<Record<string, unknown>>(
          env,
          '/data/design-trees/shard-' +
            String(Math.floor(candidateId / 1000)).padStart(3, '0') +
            '.json',
        ),
        raw = shard[String(candidateId)];
      if (!isDesignDraft(raw))
        throw new ApiError(
          503,
          'dataset_unavailable',
          '후보 설계를 불러오지 못했습니다.',
        );
      draft = hydrateDraft(raw);
    } else {
      const { baseline } = await loadContext(env, project.draft);
      try {
        draft = applyDraftChanges(
          project.draft,
          payload.changes ?? [],
          baseline,
          payload.locks,
        );
      } catch {
        throw new ApiError(
          409,
          'invalid_proposal',
          '변경안의 값·범위·잠금 조건이 일치하지 않습니다.',
        );
      }
    }
    const now = new Date().toISOString();
    const outcomes = await db.batch([
      db
        .prepare(
          "UPDATE agent_projects SET draft_json=?,fingerprint=?,source_id=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? AND EXISTS(SELECT 1 FROM agent_proposals WHERE id=? AND status='proposed')",
        )
        .bind(
          JSON.stringify(draft),
          draftFingerprint(draft),
          payload.operation === 'select_dataset_design'
            ? null
            : project.sourceId,
          now,
          project.id,
          user.id,
          row.revision,
          id,
        ),
      db
        .prepare(
          "UPDATE agent_proposals SET status='applied' WHERE id=? AND user_id=? AND changes()=1",
        )
        .bind(id, user.id),
    ]);
    if (!outcomes[0].meta.changes)
      throw new ApiError(
        409,
        'stale_revision',
        '설계가 변경되었습니다. 다시 평가해 주세요.',
      );
    return json(await getProject(db, user.id, project.id));
  } catch (error) {
    return fail(error);
  }
}
