import asyncio
import json
from typing import Annotated, Literal
from uuid import UUID, uuid4
import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field, StringConstraints, ValidationError, ConfigDict
from sqlalchemy import select, insert, update
from . import auth, database as d
from .core.errors import ApiError
from .store import iso

router = APIRouter()
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
PositiveInt = Annotated[int, Field(strict=True, gt=0)]


class Body(BaseModel):
    model_config = ConfigDict(extra='ignore')


class CreateProject(Body):
    title: ShortText
    draft: dict
    sourceId: UUID | None = None


class SaveProject(Body):
    expectedRevision: PositiveInt
    draft: dict
    title: ShortText | None = None


class Restore(Body):
    expectedRevision: PositiveInt
    revision: PositiveInt


class Apply(Body):
    expectedRevision: PositiveInt


class Run(Body):
    projectId: UUID
    revision: PositiveInt
    mode: Literal['parts', 'optimize', 'qa']
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    locks: list[Annotated[str, StringConstraints(max_length=300)]] = Field(default_factory=list, max_length=100)


class Selection(Body):
    itemId: Annotated[str, StringConstraints(max_length=300)]
    offerId: Annotated[str, StringConstraints(max_length=300)] | None


class Quote(Body):
    runId: UUID
    selections: list[Selection] = Field(max_length=200)


def response(value, status=200):
    return JSONResponse(value, status_code=status, headers={'Cache-Control':'no-store'})


async def read_json(request, maximum=1_000_000):
    auth.same_origin(request)
    if not request.headers.get('content-type', '').startswith('application/json'):
        raise ApiError(415, 'invalid_content_type', 'JSON 형식으로 요청해 주세요.')
    chunks = bytearray()
    async for chunk in request.stream():
        chunks.extend(chunk)
        if len(chunks) > maximum:
            raise ApiError(413, 'too_large', '요청 데이터가 너무 큽니다.')
    try:
        def reject_constant(_):
            raise ValueError('Non-finite JSON')
        value = json.loads(chunks, parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError('Object required')
        return value
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ApiError(400, 'invalid_json', 'JSON 형식을 확인해 주세요.') from None


async def body(request, model, maximum=1_000_000):
    try:
        return model.model_validate(await read_json(request, maximum))
    except ValidationError:
        raise ApiError(400, 'invalid_input', '입력값을 확인해 주세요.') from None


def validated(request, draft):
    from .services.dataset import load_context, catalogs
    from .domain.draft import validate_draft
    settings = request.app.state.settings
    context = load_context(settings, draft)
    return validate_draft(draft, context['baseline'], catalogs(settings))


@router.get('/agent/session')
async def session(request: Request):
    absent = auth.missing(request.app.state.settings)
    if absent:
        return response(dict(configured=False, user=None, missing=absent, usage=None))
    user = await auth.get_user(request)
    return response(dict(configured=True, user=user, missing=[], usage=await request.app.state.store.usage(user['id']) if user else None))


@router.post('/auth/sign-in/social')
async def sign_in(request: Request):
    return await auth.sign_in(request, await read_json(request, 8000))


@router.get('/auth/callback/google')
async def auth_callback(request: Request):
    return await auth.callback(request)


@router.post('/auth/sign-out')
async def sign_out(request: Request):
    return await auth.sign_out(request)


@router.get('/auth/get-session')
async def auth_session(request: Request):
    user = await auth.get_user(request)
    return response({'user':user} if user else None)


@router.get('/projects')
async def projects(request: Request):
    user = await auth.require_user(request)
    return response({'projects':await request.app.state.store.list_projects(user['id'])})


@router.post('/projects')
async def create_project(request: Request):
    user = await auth.require_user(request); value = await body(request, CreateProject)
    return response(await request.app.state.store.create_project(user['id'], value.title, validated(request,value.draft), str(value.sourceId) if value.sourceId else None), 201)


@router.get('/projects/{project_id}')
async def get_project(project_id: str, request: Request):
    user = await auth.require_user(request)
    return response(await request.app.state.store.get_project(user['id'], project_id))


@router.patch('/projects/{project_id}')
async def save_project(project_id: str, request: Request):
    user = await auth.require_user(request); value = await body(request, SaveProject)
    await request.app.state.store.get_project(user['id'], project_id)
    return response(await request.app.state.store.save_project(user['id'], project_id, value.expectedRevision, validated(request,value.draft), value.title))


@router.post('/projects/{project_id}/restore')
async def restore(project_id: str, request: Request):
    user = await auth.require_user(request); value = await body(request, Restore)
    return response(await request.app.state.store.restore_project(user['id'], project_id, value.expectedRevision, value.revision))


@router.get('/projects/{project_id}/quotes')
async def quotes(project_id: str, request: Request):
    user = await auth.require_user(request)
    return response({'quotes':await request.app.state.store.list_quotes(user['id'], project_id)})


@router.post('/projects/{project_id}/quotes')
async def save_quote(project_id: str, request: Request):
    user = await auth.require_user(request); value = await body(request, Quote, 64000)
    return response(await request.app.state.store.save_quote(user['id'], project_id, str(value.runId), [x.model_dump() for x in value.selections]), 201)


@router.get('/agent/runs')
async def runs(request: Request, projectId: str | None = None):
    user = await auth.require_user(request)
    if not projectId or not valid_id(projectId):
        raise ApiError(400, 'invalid_input', '????? ??? ???.')
    return response({'runs':await request.app.state.store.list_runs(user['id'], projectId)})


@router.get('/agent/runs/{run_id}')
async def get_run(run_id: str, request: Request):
    user = await auth.require_user(request)
    return response(await request.app.state.store.get_run(user['id'], run_id))


@router.post('/agent/runs/{run_id}/cancel')
async def cancel_run(run_id: str, request: Request):
    auth.same_origin(request); user = await auth.require_user(request)
    await request.app.state.store.cancel_run(user['id'], run_id)
    return response({'cancelled':True})


@router.post('/design-proposals/{proposal_id}/apply')
async def apply_proposal(proposal_id: str, request: Request):
    from .services.dataset import load_context, load_design
    from .domain.optimization import apply_draft_changes
    user = await auth.require_user(request); value = await body(request, Apply, 4000)
    store = request.app.state.store; settings = request.app.state.settings
    proposal = await store.get_proposal(user['id'], proposal_id)
    project = await store.get_project(user['id'], proposal['project_id'])
    if proposal['status'] != 'proposed' or project['revision'] != value.expectedRevision or project['revision'] != proposal['revision'] or project['fingerprint'] != proposal['fingerprint']:
        raise ApiError(409, 'stale_proposal', '이미 적용되었거나 이전 설계 기준인 변경안입니다.')
    payload = proposal['payload_json']
    if proposal['operation'] == 'select_dataset_design':
        draft = load_design(settings, payload['candidateDesignId'])
    elif proposal['operation'] == 'patch_draft':
        draft = apply_draft_changes(project['draft'], payload.get('changes', []), load_context(settings, project['draft'])['baseline'], payload.get('locks', []))
    else:
        raise ApiError(409, 'invalid_proposal', '변경안의 작업 형식을 확인해 주세요.')
    return response(await store.apply_proposal(user['id'], proposal_id, value.expectedRevision, draft))


@router.post('/agent/run')
async def run_agent(request: Request):
    user = await auth.require_user(request); value = await body(request, Run, 32000)
    store = request.app.state.store; settings = request.app.state.settings
    project = await store.get_project(user['id'], str(value.projectId))
    if project['revision'] != value.revision:
        raise ApiError(409, 'stale_revision', '최신 설계로 다시 실행해 주세요.')
    if value.mode != 'parts' and not settings.openai_api_key:
        raise ApiError(503, 'not_configured', 'OpenAI API 설정이 필요합니다.')
    run_id = await store.start_run(user['id'], project, value.mode, value.message)

    async def stream():
        from .services.runner import execute_run
        queue = asyncio.Queue(maxsize=100); cancel_event = asyncio.Event()

        async def emit(event):
            if not cancel_event.is_set():
                await queue.put(event)

        async def work():
            try:
                async with asyncio.timeout(240):
                    result = await execute_run(dict(session_factory=request.app.state.session_factory, settings=settings, store=store,
                        user_id=user['id'], run_id=run_id, project=project, mode=value.mode, message=value.message, locks=value.locks,
                        emit=emit, cancel_event=cancel_event, performance=getattr(request.app.state, 'performance', None)))
                    status = 'partial' if any(any(part in w for part in ('완료하지 못','설정이 필요','확인해 주세요')) for w in result.get('warnings', [])) else 'completed'
                    if cancel_event.is_set() or not await store.finish_run(user['id'], run_id, status, result):
                        raise ApiError(409, 'cancelled', '작업이 취소되었습니다.')
                    await emit(dict(type='result', runId=run_id, result=result))
            except (asyncio.CancelledError, TimeoutError):
                cancel_event.set()
                await store.cancel_run(user['id'], run_id)
                await queue.put(dict(type='error', runId=run_id, message='작업이 취소되었거나 제한 시간을 초과했습니다.'))
            except Exception as error:
                if cancel_event.is_set() or await store.is_cancelled(user['id'], run_id):
                    await store.cancel_run(user['id'], run_id)
                else:
                    saved = await store.get_run(user['id'], run_id)
                    await store.finish_run(user['id'], run_id, 'partial' if saved['result'] else 'failed', saved['result'])
                await queue.put(dict(type='error', runId=run_id, message=error.message if isinstance(error,ApiError) else '작업을 완료하지 못했습니다. 저장된 결과를 확인해 주세요.'))
            finally:
                await queue.put(None)

        worker = asyncio.create_task(work())

        async def monitor():
            while not worker.done():
                await asyncio.sleep(1)
                try:
                    cancelled = await store.is_cancelled(user['id'], run_id)
                except Exception:
                    cancelled = True
                if cancelled:
                    cancel_event.set(); worker.cancel(); return

        watcher = asyncio.create_task(monitor())
        try:
            yield json.dumps(dict(type='start', runId=run_id, message='작업을 시작했습니다.'), ensure_ascii=False)+'\n'
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield json.dumps(event, ensure_ascii=False, allow_nan=False)+'\n'
        finally:
            cancel_event.set(); watcher.cancel()
            if not worker.done():
                worker.cancel()
            # A disconnected consumer must not interrupt the durable cancellation write.
            with anyio.CancelScope(shield=True):
                await asyncio.gather(worker, watcher, return_exceptions=True)
                await store.cancel_run(user['id'], run_id)

    return StreamingResponse(stream(), media_type='application/x-ndjson', headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'})


@router.post('/parts/search')
async def part_search(request: Request):
    try:
        return await _part_search(request)
    except ApiError as error:
        status = 'rate_limited' if error.status == 429 else 'not_configured' if error.status == 503 else 'error'
        return response(dict(itemId='', status=status, offers=[], warnings=[error.message], retrievedAt=iso()), error.status)
    except Exception:
        return response(dict(itemId='', status='error', offers=[], warnings=['?? ??? ???? ?????.'], retrievedAt=iso()), 500)


async def _part_search(request: Request):
    from .domain.bom import create_bom_snapshot
    from .services.parts import search_parts
    value = await read_json(request, 16384)
    user = await auth.require_user(request); store = request.app.state.store
    try:
        project_id = str(UUID(value['projectId'])); revision = value['revision']; item_id = value['item']['id']
        if not isinstance(revision, int) or isinstance(revision,bool) or revision <= 0 or value.get('country') != 'KR' or value.get('currency') != 'KRW':
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, 'invalid_input', '프로젝트·부품·한국 배송·원화 설정을 확인해 주세요.') from None
    project = await store.get_project(user['id'], project_id)
    if project['revision'] != revision:
        raise ApiError(409, 'stale_revision', '최신 설계로 다시 검색해 주세요.')
    snapshot = create_bom_snapshot(project['draft'])
    item = next((x for x in snapshot['items'] if x['id'] == item_id), None)
    if item is None:
        raise ApiError(400, 'invalid_item', '현재 설계에 없는 부품입니다.')
    run_id = await store.start_run(user['id'], project, 'parts', '부품 조회: '+item['model'])
    try:
        async def charge(kind='provider'):
            await store.consume_budget(user['id'], run_id, 'llm' if kind == 'ai' else kind)
        result = await search_parts(item, request.app.state.settings, consume_budget=charge, cancel_event=asyncio.Event(), allow_ai=True)
        record = dict(answer=' '.join(result.get('warnings', [])), evidence=[], proposals=[], warnings=result.get('warnings', []),
            context=dict(projectId=project_id, revision=revision, fingerprint=project['fingerprint']),
            quote=dict(snapshot=snapshot, lines=[dict(item=x, result=result if x['id']==item_id else None, selectedOfferId=None) for x in snapshot['items']]))
        await store.finish_run(user['id'], run_id, 'completed' if result['status'] in ('ok','not_found') else 'partial', record)
        code = {'not_configured':503,'rate_limited':429,'error':502,'permission_denied':502}.get(result['status'],200)
        return response(result, code)
    except BaseException:
        with anyio.CancelScope(shield=True):
            await store.cancel_run(user['id'], run_id)
        raise


@router.get('/integrations/aliexpress/callback')
async def affiliate_callback(request: Request):
    rejected = any(key in request.query_params for key in ('code','error','access_token'))
    return HTMLResponse('<!doctype html><html lang="ko"><meta charset="utf-8"><title>drawn AliExpress Affiliates</title><body><h1>drawn AliExpress Affiliates</h1><p>Affiliate 앱 등록용 안내 경로입니다. 판매자 OAuth 인증을 처리하지 않습니다.</p></body></html>',
        status_code=400 if rejected else 200, headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})


def gallery_value(row, detail=False):
    value = dict(id=row['id'], title=row['title'], author=row['author'], purpose=row['purpose'], description=row['description'],
        createdAt=row['created_at'], parentId=row['parent_id'], baselineId=row['baseline_id'], numPropellers=row['num_propellers'], numWings=row['num_wings'], reuses=row['reuses'])
    if detail:
        value['draft'] = row['draft_json']
    return value


def valid_id(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value.lower()
    except ValueError:
        return False


@router.get('/gallery')
async def gallery_read(request: Request, id: str | None = None):
    async with request.app.state.session_factory() as s:
        if id:
            if not valid_id(id):
                raise ApiError(400, 'invalid_input', '올바르지 않은 공유 주소입니다.')
            row = (await s.execute(select(d.gallery).where(d.gallery.c.id == id))).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '게시물을 찾을 수 없습니다.')
            return response(gallery_value(row, True))
        rows = (await s.execute(select(d.gallery).order_by(d.gallery.c.created_at.desc(), d.gallery.c.id.desc()).limit(100))).mappings()
        return response([gallery_value(r) for r in rows])


@router.post('/gallery')
async def gallery_write(request: Request):
    from .domain.draft import is_design_draft
    value = await read_json(request, 2_000_000)
    async with request.app.state.session_factory.begin() as s:
        if value.get('action') == 'reuse':
            if not valid_id(value.get('id')):
                raise ApiError(400, 'invalid_input', '올바르지 않은 게시물입니다.')
            row = (await s.execute(update(d.gallery).where(d.gallery.c.id == value['id']).values(reuses=d.gallery.c.reuses+1).returning(d.gallery))).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '게시물을 찾을 수 없습니다.')
            return response(gallery_value(row, True))
        bounded = lambda key, limit: isinstance(value.get(key),str) and 0 < len(value[key].strip()) <= limit
        if not (bounded('title',80) and bounded('author',30) and bounded('description',1000) and value.get('purpose') in ('취미·입문','촬영·관측','장거리 비행','레이싱','운송·탑재','연구·실험') and value.get('allowReuse') is True and is_design_draft(value.get('draft'))):
            raise ApiError(400, 'invalid_input', '공유 내용·설계 데이터·복사 수정 동의를 확인해 주세요.')
        parent = value.get('parentId')
        if parent is not None and (not valid_id(parent) or (await s.execute(select(d.gallery.c.id).where(d.gallery.c.id == parent))).first() is None):
            raise ApiError(400, 'invalid_input', '원본 게시물을 찾을 수 없습니다.')
        draft = value['draft']; post_id = str(uuid4())
        await s.execute(insert(d.gallery).values(id=post_id,title=value['title'].strip(),author=value['author'].strip(),purpose=value['purpose'],description=value['description'].strip(),created_at=iso(),parent_id=parent,baseline_id=draft['baselineId'],num_propellers=draft['numPropellers'],num_wings=draft['numWings'],reuses=0,draft_json=draft))
        return response({'id':post_id}, 201)
