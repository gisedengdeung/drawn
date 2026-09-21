"""Short database transactions preserve revisions, ownership and paid-call budgets."""
import copy
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from sqlalchemy import select, insert, update, and_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from . import database as d
from .core.errors import ApiError

LIMITS = {'user': 20, 'global': 200, 'llm': 4, 'tool': 20, 'provider': 40}


def milliseconds():
    return int(time.time() * 1000)


def iso(now=None):
    return datetime.fromtimestamp((milliseconds() if now is None else now) / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def day_key(now=None):
    return datetime.fromtimestamp((milliseconds() if now is None else now) / 1000, timezone(timedelta(hours=9))).date().isoformat()


def project_value(r):
    return dict(id=r['id'], title=r['title'], revision=r['revision'], fingerprint=r['fingerprint'],
                draft=r['draft_json'], sourceId=r['source_id'], updatedAt=r['updated_at'])


def run_value(r):
    return dict(id=r['id'], projectId=r['project_id'], revision=r['revision'], mode=r['mode'],
                status='cancelled' if r['status'] == 'running' and r['lease_until'] <= milliseconds() else r['status'],
                message=r['message'], result=r['result_json'], createdAt=r['created_at'])


class Store:
    def __init__(self, session_factory):
        self.session_factory = session_factory

    async def _project(self, session, user_id, project_id):
        row = (await session.execute(select(d.projects).where(d.projects.c.id == project_id, d.projects.c.user_id == user_id))).mappings().first()
        if not row:
            raise ApiError(404, 'not_found', '프로젝트를 찾을 수 없습니다.')
        return row

    async def get_project(self, user_id, project_id):
        async with self.session_factory() as s:
            return project_value(await self._project(s, user_id, project_id))

    async def list_projects(self, user_id):
        async with self.session_factory() as s:
            rows = (await s.execute(select(d.projects).where(d.projects.c.user_id == user_id).order_by(d.projects.c.updated_at.desc()).limit(50))).mappings()
            return [project_value(r) for r in rows]

    async def _history(self, s, row):
        await s.execute(insert(d.revisions).values(project_id=row['id'], revision=row['revision'], fingerprint=row['fingerprint'], draft_json=row['draft_json'], created_at=row['updated_at']))

    async def create_project(self, user_id, title, draft, source_id=None):
        from .domain.draft import fingerprint
        row = dict(id=str(uuid4()), user_id=user_id, title=title, revision=1, fingerprint=fingerprint(draft), draft_json=draft, source_id=source_id, updated_at=iso())
        async with self.session_factory.begin() as s:
            await s.execute(insert(d.projects).values(**row))
            await self._history(s, row)
        return project_value(row)

    async def _save(self, s, user_id, project_id, expected_revision, draft, title=None, source_id=...):
        from .domain.draft import fingerprint
        old = await self._project(s, user_id, project_id)
        values = dict(draft_json=draft, fingerprint=fingerprint(draft), title=old['title'] if title is None else title,
                      revision=d.projects.c.revision + 1, updated_at=iso())
        if source_id is not ...:
            values['source_id'] = source_id
        row = (await s.execute(update(d.projects).where(d.projects.c.id == project_id, d.projects.c.user_id == user_id,
                    d.projects.c.revision == expected_revision).values(**values).returning(d.projects))).mappings().first()
        if not row:
            raise ApiError(409, 'stale_revision', '최신 프로젝트를 불러온 뒤 다시 적용해 주세요.')
        await self._history(s, row)
        return project_value(row)

    async def save_project(self, user_id, project_id, expected_revision, draft, title=None):
        async with self.session_factory.begin() as s:
            return await self._save(s, user_id, project_id, expected_revision, draft, title)

    async def restore_project(self, user_id, project_id, expected_revision, revision):
        async with self.session_factory.begin() as s:
            await self._project(s, user_id, project_id)
            row = (await s.execute(select(d.revisions).where(d.revisions.c.project_id == project_id, d.revisions.c.revision == revision))).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '저장된 버전을 찾을 수 없습니다.')
            return await self._save(s, user_id, project_id, expected_revision, row['draft_json'])

    async def usage(self, user_id):
        day = day_key()
        async with self.session_factory() as s:
            rows = (await s.execute(select(d.usage).where(d.usage.c.day == day, d.usage.c.bucket.in_([user_id, '*'])))).mappings()
            counts = {r['bucket']: r['count'] for r in rows}
        reset = datetime.fromisoformat(day).replace(tzinfo=timezone(timedelta(hours=9))) + timedelta(days=1)
        return dict(used=counts.get(user_id, 0), limit=LIMITS['user'], globalRemaining=max(0, LIMITS['global']-counts.get('*', 0)), resetAt=reset.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))

    async def start_run(self, user_id, project, mode, message):
        now = milliseconds(); day = day_key(now); run_id = str(uuid4())
        try:
            async with self.session_factory.begin() as s:
                # Consistent global -> user ordering serializes the last available slot.
                for bucket in ('*', user_id):
                    await s.execute(pg_insert(d.usage).values(bucket=bucket, day=day, count=0).on_conflict_do_nothing())
                    row = (await s.execute(select(d.usage).where(d.usage.c.bucket == bucket, d.usage.c.day == day).with_for_update())).mappings().one()
                    if row['count'] >= LIMITS['global' if bucket == '*' else 'user']:
                        raise ApiError(429, 'daily_limit', '오늘의 Agent 실행 한도에 도달했습니다.')
                current = await self._project(s, user_id, project['id'])
                if current['revision'] != project['revision']:
                    raise ApiError(409, 'stale_revision', '최신 설계로 다시 실행해 주세요.')
                await s.execute(update(d.runs).where(d.runs.c.user_id == user_id, d.runs.c.status == 'running', d.runs.c.lease_until <= now).values(status='cancelled', cancel_requested=True, updated_at=iso(now)))
                await s.execute(insert(d.runs).values(id=run_id, user_id=user_id, project_id=project['id'], revision=project['revision'], mode=mode,
                    status='running', message=message, created_at=iso(now), updated_at=iso(now), lease_until=now+300000, day=day,
                    llm_calls=0, tool_calls=0, provider_calls=0, cancel_requested=False))
                await s.execute(update(d.usage).where(d.usage.c.day == day, d.usage.c.bucket.in_(['*', user_id])).values(count=d.usage.c.count+1))
        except IntegrityError as error:
            if 'agent_one_running' in str(error):
                raise ApiError(409, 'already_running', '진행 중인 작업을 마치거나 취소해 주세요.') from None
            raise
        return run_id

    def _active(self, user_id, run_id):
        return and_(d.runs.c.id == run_id, d.runs.c.user_id == user_id, d.runs.c.status == 'running',
                    d.runs.c.cancel_requested.is_(False), d.runs.c.lease_until > milliseconds())

    async def consume_budget(self, user_id, run_id, kind):
        if kind not in ('llm', 'tool', 'provider'):
            raise ValueError('Unknown budget kind')
        column = d.runs.c[kind+'_calls']
        async with self.session_factory.begin() as s:
            row = (await s.execute(update(d.runs).where(self._active(user_id, run_id), column < LIMITS[kind]).values({column.name:column+1}).returning(d.runs.c.id))).first()
            if not row:
                raise ApiError(429, 'budget_or_cancelled', '작업이 취소되었거나 실행 한도에 도달했습니다.')

    async def is_cancelled(self, user_id, run_id):
        async with self.session_factory() as s:
            return (await s.execute(select(d.runs.c.id).where(self._active(user_id, run_id)))).first() is None

    async def get_run(self, user_id, run_id):
        async with self.session_factory() as s:
            row = (await s.execute(select(d.runs).where(d.runs.c.id == run_id, d.runs.c.user_id == user_id))).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '작업을 찾을 수 없습니다.')
            return run_value(row)

    async def list_runs(self, user_id, project_id):
        async with self.session_factory() as s:
            await self._project(s, user_id, project_id)
            rows = (await s.execute(select(d.runs).where(d.runs.c.user_id == user_id, d.runs.c.project_id == project_id).order_by(d.runs.c.created_at.desc()).limit(30))).mappings()
            return [run_value(r) for r in rows]

    async def finish_run(self, user_id, run_id, status, result):
        if status not in ('completed', 'partial', 'failed'):
            raise ValueError('Invalid terminal status')
        async with self.session_factory.begin() as s:
            row = (await s.execute(update(d.runs).where(self._active(user_id, run_id)).values(status=status, result_json=result, updated_at=iso()).returning(d.runs.c.id))).first()
            return row is not None

    async def checkpoint_result(self, user_id, run_id, result):
        async with self.session_factory.begin() as s:
            row = (await s.execute(update(d.runs).where(self._active(user_id, run_id)).values(result_json=result, updated_at=iso()).returning(d.runs.c.id))).first()
            if not row:
                raise ApiError(409, 'cancelled', '작업이 취소되었습니다.')

    async def cancel_run(self, user_id, run_id):
        await self.get_run(user_id, run_id)
        async with self.session_factory.begin() as s:
            await s.execute(update(d.runs).where(d.runs.c.id == run_id, d.runs.c.user_id == user_id, d.runs.c.status == 'running').values(status='cancelled', cancel_requested=True, updated_at=iso()))

    async def expire_runs(self):
        async with self.session_factory.begin() as s:
            await s.execute(update(d.runs).where(d.runs.c.status == 'running', d.runs.c.lease_until <= milliseconds()).values(status='cancelled', cancel_requested=True, updated_at=iso()))

    async def save_proposal(self, user_id, run_id, project, proposal, payload):
        proposal_id = str(uuid4())
        async with self.session_factory.begin() as s:
            active = (await s.execute(select(d.runs.c.id).where(self._active(user_id, run_id)).with_for_update())).first()
            if not active:
                raise ApiError(409, 'cancelled', '작업이 취소되었습니다.')
            await s.execute(insert(d.proposals).values(id=proposal_id, user_id=user_id, project_id=project['id'], run_id=run_id,
                revision=project['revision'], fingerprint=project['fingerprint'], operation=proposal['operation'], payload_json=payload, status='proposed', created_at=iso()))
        return proposal_id

    async def get_proposal(self, user_id, proposal_id):
        async with self.session_factory() as s:
            row = (await s.execute(select(d.proposals).join(d.runs, d.proposals.c.run_id == d.runs.c.id).where(d.proposals.c.id == proposal_id,
                d.proposals.c.user_id == user_id, d.runs.c.user_id == user_id, d.runs.c.status.in_(['completed','partial'])))).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '완료된 변경안을 찾을 수 없습니다.')
            return dict(row)

    async def apply_proposal(self, user_id, proposal_id, expected_revision, draft):
        async with self.session_factory.begin() as s:
            row = (await s.execute(select(d.proposals).where(d.proposals.c.id == proposal_id, d.proposals.c.user_id == user_id).with_for_update())).mappings().first()
            if not row:
                raise ApiError(404, 'not_found', '변경안을 찾을 수 없습니다.')
            run = (await s.execute(select(d.runs.c.status).where(d.runs.c.id == row['run_id'], d.runs.c.user_id == user_id))).scalar_one_or_none()
            old = await self._project(s, user_id, row['project_id'])
            if run not in ('completed','partial') or row['status'] != 'proposed' or old['revision'] != expected_revision or row['revision'] != expected_revision or old['fingerprint'] != row['fingerprint']:
                raise ApiError(409, 'stale_proposal', '이미 적용되었거나 이전 설계 기준인 변경안입니다.')
            value = await self._save(s, user_id, row['project_id'], expected_revision, draft,
                source_id=None if row['operation'] == 'select_dataset_design' else old['source_id'])
            await s.execute(update(d.proposals).where(d.proposals.c.id == proposal_id).values(status='applied'))
            return value

    async def list_quotes(self, user_id, project_id):
        async with self.session_factory() as s:
            await self._project(s, user_id, project_id)
            rows = (await s.execute(select(d.quotes).where(d.quotes.c.user_id == user_id, d.quotes.c.project_id == project_id).order_by(d.quotes.c.created_at.desc()).limit(30))).mappings()
            return [dict(id=r['id'], runId=r['run_id'], createdAt=r['created_at'], quote=r['quote_json']) for r in rows]

    async def save_quote(self, user_id, project_id, run_id, selections):
        await self.get_project(user_id, project_id)
        run = await self.get_run(user_id, run_id)
        if run['projectId'] != project_id or not (run['result'] or {}).get('quote'):
            raise ApiError(400, 'invalid_quote', '이 프로젝트의 견적이 아닙니다.')
        quote = copy.deepcopy(run['result']['quote']); seen = set()
        for selection in selections:
            item_id, offer_id = selection['itemId'], selection['offerId']
            line = next((x for x in quote['lines'] if x['item']['id'] == item_id), None)
            if line is None or item_id in seen or (offer_id is not None and not any(x['id'] == offer_id for x in (line.get('result') or {}).get('offers', []))):
                raise ApiError(400, 'invalid_offer', '조회 결과에 없는 상품입니다.')
            seen.add(item_id); line['selectedOfferId'] = offer_id
        record = dict(id=str(uuid4()), runId=run_id, createdAt=iso(), quote=quote)
        async with self.session_factory.begin() as s:
            await s.execute(insert(d.quotes).values(id=record['id'], user_id=user_id, project_id=project_id, run_id=run_id, quote_json=quote, created_at=record['createdAt']))
        return record
