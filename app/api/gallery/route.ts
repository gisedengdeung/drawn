import { env } from 'cloudflare:workers';
import { galleryPurposes, isDesignDraft } from '@/lib/design-gallery';
import type { GalleryPost } from '@/lib/design-gallery';

export const dynamic = 'force-dynamic';
const columns = 'id, title, author, purpose, description, created_at AS createdAt, parent_id AS parentId, baseline_id AS baselineId, num_propellers AS numPropellers, num_wings AS numWings, reuses';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);

async function database() {
  const databases = env as unknown as { GALLERY_DB?: D1Database; AGENT_DB?: D1Database };
  const db = databases.GALLERY_DB ?? databases.AGENT_DB;
  if (!db) throw new Error('갤러리 저장소가 연결되지 않았습니다.');
  if (databases.GALLERY_DB) await db.prepare(`CREATE TABLE IF NOT EXISTS gallery_posts (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
    purpose TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL,
    parent_id TEXT, baseline_id INTEGER NOT NULL, num_propellers INTEGER NOT NULL,
    num_wings INTEGER NOT NULL, reuses INTEGER NOT NULL DEFAULT 0, draft_json TEXT NOT NULL
  )`).run();
  return db;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  try {
    const db = await database();
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      if (!validId(id)) return json({ error: '올바르지 않은 공유 주소입니다.' }, 400);
      const row = await db.prepare(`SELECT ${columns}, draft_json FROM gallery_posts WHERE id = ?`).bind(id).first<GalleryPost & { draft_json: string }>();
      if (!row) return json({ error: '게시물을 찾을 수 없습니다.' }, 404);
      const { draft_json, ...post } = row;
      return json({ ...post, draft: JSON.parse(draft_json) });
    }
    const result = await db.prepare(`SELECT ${columns} FROM gallery_posts ORDER BY created_at DESC, id DESC LIMIT 100`).all<GalleryPost>();
    return json(result.results);
  } catch (error) {
    console.error('Gallery read failed', error);
    return json({ error: '갤러리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}

export async function POST(request: Request) {
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: '허용되지 않은 요청입니다.' }, 403);
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 2_000_000) return json({ error: '설계 데이터는 2MB 이하여야 합니다.' }, 413);
    let input;
    try { input = JSON.parse(body); } catch { return json({ error: '올바른 JSON 데이터가 아닙니다.' }, 400); }
    if (!input || typeof input !== 'object') return json({ error: '요청 데이터가 없습니다.' }, 400);
    const db = await database();
    if (input.action === 'reuse') {
      if (!validId(input.id)) return json({ error: '올바르지 않은 게시물입니다.' }, 400);
      const row = await db.prepare(`UPDATE gallery_posts SET reuses = reuses + 1 WHERE id = ? RETURNING ${columns}, draft_json`).bind(input.id).first<GalleryPost & { draft_json: string }>();
      if (!row) return json({ error: '게시물을 찾을 수 없습니다.' }, 404);
      const { draft_json, ...post } = row;
      return json({ ...post, draft: JSON.parse(draft_json) });
    }
    const bounded = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
    if (!bounded(input.title, 80) || !bounded(input.author, 30) || !bounded(input.description, 1000) || !galleryPurposes.includes(input.purpose) || input.allowReuse !== true || !isDesignDraft(input.draft)) {
      return json({ error: '제목·닉네임·설명·사용목적과 설계 데이터, 복사·수정 동의를 확인해 주세요.' }, 400);
    }
    if (input.parentId != null) {
      if (!validId(input.parentId) || !await db.prepare('SELECT id FROM gallery_posts WHERE id = ?').bind(input.parentId).first()) return json({ error: '원본 게시물을 찾을 수 없습니다.' }, 400);
    }
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO gallery_posts (id, title, author, purpose, description, created_at, parent_id, baseline_id, num_propellers, num_wings, draft_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.title.trim(), input.author.trim(), input.purpose, input.description.trim(), new Date().toISOString(), input.parentId ?? null, input.draft.baselineId, input.draft.numPropellers, input.draft.numWings, JSON.stringify(input.draft)).run();
    return json({ id }, 201);
  } catch (error) {
    console.error('Gallery write failed', error);
    return json({ error: '저장하지 못했습니다. 입력 내용은 유지되니 다시 시도해 주세요.' }, 503);
  }
}
