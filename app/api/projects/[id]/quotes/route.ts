import { z } from 'zod';
import { requireUser } from '../../../../../lib/agent/server/auth';
import {
  json,
  fail,
  readJson,
  ApiError,
} from '../../../../../lib/agent/server/http';
import { getProject, getRun } from '../../../../../lib/agent/server/store';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: Context) {
  try {
    const { db, user } = await requireUser(request),
      id = (await context.params).id;
    await getProject(db, user.id, id);
    const rows = await db
      .prepare(
        'SELECT id,run_id,quote_json,created_at FROM agent_quotes WHERE user_id=? AND project_id=? ORDER BY created_at DESC LIMIT 30',
      )
      .bind(user.id, id)
      .all<{
        id: string;
        run_id: string;
        quote_json: string;
        created_at: string;
      }>();
    return json({
      quotes: rows.results.map((r) => ({
        id: r.id,
        runId: r.run_id,
        createdAt: r.created_at,
        quote: JSON.parse(r.quote_json),
      })),
    });
  } catch (error) {
    return fail(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const { db, user } = await requireUser(request),
      id = (await context.params).id;
    await getProject(db, user.id, id);
    const parsed = z
      .object({
        runId: z.uuid(),
        selections: z
          .array(
            z.object({
              itemId: z.string().max(300),
              offerId: z.string().max(300).nullable(),
            }),
          )
          .max(200),
      })
      .safeParse(await readJson(request, 64000));
    if (!parsed.success)
      throw new ApiError(400, 'invalid_input', '선택한 상품을 확인해 주세요.');
    const run = await getRun(db, user.id, parsed.data.runId);
    if (run.projectId !== id || !run.result?.quote)
      throw new ApiError(
        400,
        'invalid_quote',
        '이 프로젝트의 견적이 아닙니다.',
      );
    const quote = structuredClone(run.result.quote),
      seen = new Set<string>();
    for (const selection of parsed.data.selections) {
      const line = quote.lines.find((x) => x.item.id === selection.itemId);
      if (
        !line ||
        seen.has(selection.itemId) ||
        (selection.offerId !== null &&
          !line.result?.offers.some((x) => x.id === selection.offerId))
      )
        throw new ApiError(
          400,
          'invalid_offer',
          '조회 결과에 없는 상품입니다.',
        );
      seen.add(selection.itemId);
      line.selectedOfferId = selection.offerId;
    }
    const record = {
      id: crypto.randomUUID(),
      runId: run.id,
      createdAt: new Date().toISOString(),
      quote,
    };
    await db
      .prepare(
        'INSERT INTO agent_quotes(id,user_id,project_id,run_id,quote_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .bind(
        record.id,
        user.id,
        id,
        run.id,
        JSON.stringify(quote),
        record.createdAt,
      )
      .run();
    return json(record, 201);
  } catch (error) {
    return fail(error);
  }
}
