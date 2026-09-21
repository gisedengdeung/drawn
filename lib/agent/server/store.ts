import type { DesignDraft } from '../../drawn-types';
import { draftFingerprint } from '../../parts/bom';
import type { AgentMode, AgentResult, AgentRun, Project } from '../types';
import { ApiError } from './http';
type ProjectRow = {
  id: string;
  user_id: string;
  title: string;
  revision: number;
  fingerprint: string;
  draft_json: string;
  source_id: string | null;
  updated_at: string;
};
export const limits = { user: 20, global: 200, llm: 4, tool: 20, provider: 40 };
export const dayKey = (time = Date.now()) =>
  new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
export function projectValue(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    fingerprint: row.fingerprint,
    draft: JSON.parse(row.draft_json),
    sourceId: row.source_id,
    updatedAt: row.updated_at,
  };
}
export async function getProject(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Project> {
  const row = await db
    .prepare('SELECT * FROM agent_projects WHERE id=? AND user_id=?')
    .bind(id, userId)
    .first<ProjectRow>();
  if (!row)
    throw new ApiError(404, 'not_found', '프로젝트를 찾을 수 없습니다.');
  return projectValue(row);
}
export async function listProjects(db: D1Database, userId: string) {
  const rows = await db
    .prepare(
      'SELECT * FROM agent_projects WHERE user_id=? ORDER BY updated_at DESC LIMIT 50',
    )
    .bind(userId)
    .all<ProjectRow>();
  return rows.results.map(projectValue);
}
export async function createProject(
  db: D1Database,
  userId: string,
  title: string,
  draft: DesignDraft,
  sourceId: string | null,
) {
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        'INSERT INTO agent_projects(id,user_id,title,revision,fingerprint,draft_json,source_id,updated_at) VALUES(?,?,?,1,?,?,?,?)',
      )
      .bind(
        id,
        userId,
        title,
        draftFingerprint(draft),
        JSON.stringify(draft),
        sourceId,
        now,
      ),
    db
      .prepare(
        'INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) SELECT id,revision,fingerprint,draft_json,updated_at FROM agent_projects WHERE id=? AND user_id=? AND changes()=1',
      )
      .bind(id, userId),
  ]);
  return getProject(db, userId, id);
}
export async function saveProject(
  db: D1Database,
  userId: string,
  id: string,
  expectedRevision: number,
  draft: DesignDraft,
  title?: string,
) {
  const old = await getProject(db, userId, id);
  const outcomes = await db.batch([
    db
      .prepare(
        'UPDATE agent_projects SET draft_json=?,fingerprint=?,title=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?',
      )
      .bind(
        JSON.stringify(draft),
        draftFingerprint(draft),
        title ?? old.title,
        new Date().toISOString(),
        id,
        userId,
        expectedRevision,
      ),
    db
      .prepare(
        'INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) SELECT id,revision,fingerprint,draft_json,updated_at FROM agent_projects WHERE id=? AND user_id=? AND changes()=1',
      )
      .bind(id, userId),
  ]);
  if (!outcomes[0].meta.changes)
    throw new ApiError(
      409,
      'stale_revision',
      '다른 편집 내용이 저장되었습니다. 최신 프로젝트를 불러온 뒤 다시 적용해 주세요.',
    );
  return getProject(db, userId, id);
}
export async function usage(db: D1Database, userId: string) {
  const day = dayKey(),
    rows = await db
      .prepare(
        'SELECT bucket,count FROM agent_usage WHERE day=? AND bucket IN (?,?)',
      )
      .bind(day, userId, '*')
      .all<{ bucket: string; count: number }>();
  return {
    used: rows.results.find((r) => r.bucket === userId)?.count ?? 0,
    limit: limits.user,
    globalRemaining: Math.max(
      0,
      limits.global - (rows.results.find((r) => r.bucket === '*')?.count ?? 0),
    ),
    resetAt: new Date(
      Date.parse(day + 'T00:00:00+09:00') + 86400000,
    ).toISOString(),
  };
}
export async function startRun(
  db: D1Database,
  userId: string,
  project: Project,
  mode: AgentMode,
  message: string,
) {
  const id = crypto.randomUUID(),
    timestamp = Date.now(),
    now = new Date(timestamp).toISOString(),
    lease = timestamp + 300000,
    day = dayKey(timestamp);
  const quotaAvailable =
    "COALESCE((SELECT count FROM agent_usage WHERE bucket=? AND day=?),0)<? AND COALESCE((SELECT count FROM agent_usage WHERE bucket='*' AND day=?),0)<?";
  try {
    const outcomes = await db.batch([
      // The quota guard also prevents an unsuccessful admission from changing an expired run.
      db
        .prepare(
          "UPDATE agent_runs SET status='cancelled',cancel_requested=1,updated_at=? WHERE user_id=? AND status='running' AND lease_until<=? AND " +
            quotaAvailable,
        )
        .bind(
          now,
          userId,
          timestamp,
          userId,
          day,
          limits.user,
          day,
          limits.global,
        ),
      db
        .prepare(
          "INSERT INTO agent_runs(id,user_id,project_id,revision,mode,status,message,created_at,updated_at,lease_until,day) SELECT ?,?,?,?,?,'running',?,?,?,?,? WHERE " +
            quotaAvailable,
        )
        .bind(
          id,
          userId,
          project.id,
          project.revision,
          mode,
          message,
          now,
          now,
          lease,
          day,
          userId,
          day,
          limits.user,
          day,
          limits.global,
        ),
      // Every increment is gated on the preceding successful write within this transaction.
      db
        .prepare(
          'INSERT INTO agent_usage(bucket,day,count) SELECT user_id,day,1 FROM agent_runs WHERE id=? AND changes()=1 ON CONFLICT(bucket,day) DO UPDATE SET count=count+1',
        )
        .bind(id),
      db
        .prepare(
          "INSERT INTO agent_usage(bucket,day,count) SELECT '*',day,1 FROM agent_runs WHERE id=? AND changes()=1 ON CONFLICT(bucket,day) DO UPDATE SET count=count+1",
        )
        .bind(id),
    ]);
    if (!outcomes[1].meta.changes)
      throw new ApiError(
        429,
        'daily_limit',
        '오늘의 Agent 실행 한도에 도달했습니다. 내일 다시 이용해 주세요.',
      );
  } catch (error) {
    const reason = String(error);
    if (
      reason.includes('agent_runs.user_id') ||
      reason.includes('agent_one_running')
    )
      throw new ApiError(
        409,
        'already_running',
        '진행 중인 작업을 마치거나 취소한 뒤 실행해 주세요.',
      );
    throw error;
  }
  return id;
}
type RunRow = {
  lease_until: number;
  id: string;
  project_id: string;
  revision: number;
  mode: AgentMode;
  status: AgentRun['status'];
  message: string;
  result_json: string | null;
  created_at: string;
};
const runValue = (r: RunRow): AgentRun => ({
  id: r.id,
  projectId: r.project_id,
  revision: r.revision,
  mode: r.mode,
  status:
    r.status === 'running' && r.lease_until <= Date.now()
      ? 'cancelled'
      : r.status,
  message: r.message,
  result: r.result_json ? JSON.parse(r.result_json) : null,
  createdAt: r.created_at,
});
export async function getRun(db: D1Database, userId: string, id: string) {
  const row = await db
    .prepare('SELECT * FROM agent_runs WHERE id=? AND user_id=?')
    .bind(id, userId)
    .first<RunRow>();
  if (!row) throw new ApiError(404, 'not_found', '작업을 찾을 수 없습니다.');
  return runValue(row);
}
export async function listRuns(
  db: D1Database,
  userId: string,
  projectId: string,
) {
  await getProject(db, userId, projectId);
  const rows = await db
    .prepare(
      'SELECT * FROM agent_runs WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 30',
    )
    .bind(userId, projectId)
    .all<RunRow>();
  return rows.results.map(runValue);
}
export async function finishRun(
  db: D1Database,
  userId: string,
  id: string,
  status: AgentRun['status'],
  result: AgentResult | null,
) {
  const update = await db
    .prepare(
      "UPDATE agent_runs SET status=?,result_json=?,updated_at=? WHERE id=? AND user_id=? AND status='running' AND cancel_requested=0 AND lease_until>?",
    )
    .bind(
      status,
      JSON.stringify(result),
      new Date().toISOString(),
      id,
      userId,
      Date.now(),
    )
    .run();
  return Boolean(update.meta.changes);
}
export async function cancelRun(db: D1Database, userId: string, id: string) {
  await getRun(db, userId, id);
  await db
    .prepare(
      "UPDATE agent_runs SET status='cancelled',cancel_requested=1,updated_at=? WHERE id=? AND user_id=? AND status='running'",
    )
    .bind(new Date().toISOString(), id, userId)
    .run();
}
export async function consumeBudget(
  db: D1Database,
  userId: string,
  id: string,
  kind: 'llm' | 'tool' | 'provider',
) {
  const column = {
      llm: 'llm_calls',
      tool: 'tool_calls',
      provider: 'provider_calls',
    }[kind],
    limit = limits[kind];
  const result = await db
    .prepare(
      'UPDATE agent_runs SET ' +
        column +
        '=' +
        column +
        "+1 WHERE id=? AND user_id=? AND status='running' AND cancel_requested=0 AND lease_until>? AND " +
        column +
        '<?',
    )
    .bind(id, userId, Date.now(), limit)
    .run();
  if (!result.meta.changes)
    throw new ApiError(
      429,
      'budget_or_cancelled',
      '작업이 취소되었거나 실행 한도에 도달했습니다.',
    );
}
export async function isCancelled(db: D1Database, userId: string, id: string) {
  const row = await db
    .prepare(
      'SELECT status,cancel_requested,lease_until FROM agent_runs WHERE id=? AND user_id=?',
    )
    .bind(id, userId)
    .first<{ status: string; cancel_requested: number; lease_until: number }>();
  return (
    !row ||
    row.status !== 'running' ||
    Boolean(row.cancel_requested) ||
    row.lease_until <= Date.now()
  );
}
