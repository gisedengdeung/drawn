"""Real PostgreSQL concurrency tests; never substitute SQLite for row-lock checks."""
import asyncio
import os
from types import SimpleNamespace
from uuid import uuid4
from urllib.parse import urlsplit, parse_qs
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from httpx import AsyncClient, ASGITransport
from sqlalchemy import text, select, insert, update, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from backend.app import database as d, auth
from backend.app.core.errors import ApiError
from backend.app.store import Store, day_key, milliseconds
from backend.app.routers import router


@pytest_asyncio.fixture
async def db():
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('TEST_DATABASE_URL is required for PostgreSQL integration tests')
    if not url.startswith('postgresql+asyncpg://'):
        pytest.fail('PostgreSQL asyncpg test database required')
    schema = 'test_drawn_' + uuid4().hex
    admin = create_async_engine(url)
    async with admin.begin() as connection:
        await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(url, execution_options={'schema_translate_map':{None:schema}})
    async with engine.begin() as connection:
        await connection.run_sync(d.Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield Store(factory), factory
    finally:
        await engine.dispose()
        async with admin.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()


@pytest.mark.asyncio
async def test_parallel_cas_and_history_rollback(db):
    store, factory = db
    project = await store.create_project('owner', 'first', {'baselineId':1, 'value':1})
    values = await asyncio.gather(*(store.save_project('owner',project['id'],1,{'baselineId':1,'value':n}) for n in (2,3)), return_exceptions=True)
    assert sum(isinstance(v,dict) for v in values)==1
    assert next(v for v in values if isinstance(v,ApiError)).code=='stale_revision'
    async with factory.begin() as s:
        assert await s.scalar(select(func.count()).select_from(d.revisions))==2
        await s.execute(insert(d.revisions).values(project_id=project['id'],revision=3,fingerprint='conflict',draft_json={},created_at='test'))
    with pytest.raises(Exception):
        await store.save_project('owner',project['id'],2,{'value':4},'should rollback')
    saved=await store.get_project('owner',project['id'])
    assert saved['revision']==2 and saved['title']=='first'
    with pytest.raises(ApiError,match='찾을'):
        await store.get_project('other',project['id'])


@pytest.mark.asyncio
async def test_concurrent_admission_and_global_last_slot(db):
    store,factory=db
    project=await store.create_project('u1','project',{'value':1})
    attempts=await asyncio.gather(*(store.start_run('u1',project,'parts','lookup') for _ in range(2)),return_exceptions=True)
    admitted=[v for v in attempts if isinstance(v,str)]
    assert len(admitted)==1
    assert (await store.usage('u1'))['used']==1
    await store.cancel_run('u1',admitted[0])
    p2=await store.create_project('u2','project',{'value':2})
    async with factory.begin() as s:
        await s.execute(update(d.usage).where(d.usage.c.bucket=='*').values(count=199))
    attempts=await asyncio.gather(store.start_run('u1',project,'qa','first'),store.start_run('u2',p2,'qa','second'),return_exceptions=True)
    assert sum(isinstance(v,str) for v in attempts)==1
    assert next(v for v in attempts if isinstance(v,ApiError)).code=='daily_limit'
    async with factory() as s:
        assert await s.scalar(select(d.usage.c.count).where(d.usage.c.bucket=='*'))==200


@pytest.mark.asyncio
async def test_budget_cancellation_and_expiry(db,monkeypatch):
    from backend.app import store as module
    store,factory=db
    project=await store.create_project('owner','project',{'value':1})
    run=await store.start_run('owner',project,'parts','lookup')
    attempts=await asyncio.gather(*(store.consume_budget('owner',run,'provider') for _ in range(41)),return_exceptions=True)
    assert sum(v is None for v in attempts)==40
    assert sum(isinstance(v,ApiError) for v in attempts)==1
    with pytest.raises(ApiError):
        await store.consume_budget('another',run,'tool')
    async with factory() as s:
        deadline=await s.scalar(select(d.runs.c.lease_until).where(d.runs.c.id==run))
    monkeypatch.setattr(module,'milliseconds',lambda:deadline)
    assert await store.is_cancelled('owner',run)
    assert not await store.finish_run('owner',run,'completed',{})
    replacement=await store.start_run('owner',project,'parts','new')
    await store.cancel_run('owner',replacement)
    with pytest.raises(ApiError):
        await store.checkpoint_result('owner',replacement,{'late':True})
    assert (await store.get_run('owner',replacement))['result'] is None


@pytest.mark.asyncio
async def test_proposal_competition_and_quote_source_validation(db):
    store,factory=db
    project=await store.create_project('owner','project',{'value':1})
    run=await store.start_run('owner',project,'optimize','improve')
    ids=[await store.save_proposal('owner',run,project,{'operation':'patch_draft'},{'changes':[],'locks':[]}) for _ in range(2)]
    result={'quote':{'snapshot':{},'lines':[{'item':{'id':'motor'},'result':{'offers':[{'id':'real'}]},'selectedOfferId':None}]}}
    await store.finish_run('owner',run,'completed',result)
    attempts=await asyncio.gather(*(store.apply_proposal('owner',p,1,{'value':2}) for p in ids),return_exceptions=True)
    assert sum(isinstance(v,dict) for v in attempts)==1
    async with factory() as s:
        states=(await s.execute(select(d.proposals.c.status))).scalars().all()
        assert sorted(states)==['applied','proposed']
    with pytest.raises(ApiError):
        await store.save_quote('owner',project['id'],run,[{'itemId':'motor','offerId':'invented'}])
    saved=await store.save_quote('owner',project['id'],run,[{'itemId':'motor','offerId':'real'}])
    assert saved['quote']['lines'][0]['selectedOfferId']=='real'
    restored=await store.restore_project('owner',project['id'],2,1)
    assert restored['revision']==3 and restored['draft']=={'value':1}


@pytest.mark.asyncio
async def test_google_oidc_state_replay_and_imported_identity(db,monkeypatch):
    store,factory=db
    settings=SimpleNamespace(database_url='configured',app_base_url='http://testserver',session_secret='synthetic-test-secret',google_client_id='synthetic-client',google_client_secret='synthetic-secret',openai_api_key='')
    app=FastAPI();app.state.settings=settings;app.state.session_factory=factory;app.state.store=store
    app.include_router(router,prefix='/api')
    @app.exception_handler(ApiError)
    async def handler(request,error):
        return JSONResponse({'error':error.message,'code':error.code},status_code=error.status)
    async def exchange(settings,code,verifier,nonce):
        assert len(verifier)>=43 and len(nonce)>=32
        return {'sub':'google-subject','email':'synthetic@example.com','name':'Synthetic','email_verified':True}
    monkeypatch.setattr(auth,'exchange_google',exchange)
    async with factory.begin() as s:
        await s.execute(insert(d.users).values(id='preserved-id',name='Existing',email='synthetic@example.com',emailVerified=True,createdAt=1,updatedAt=1))
        await s.execute(insert(d.accounts).values(id='account',accountId='google-subject',providerId='google',userId='preserved-id',createdAt=1,updatedAt=1))
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver') as client:
        assert (await client.get('/api/agent/session')).json()['user'] is None
        foreign=await client.post('/api/auth/sign-in/social',headers={'Origin':'https://foreign.example'},json={'provider':'google'})
        assert foreign.status_code==403
        start=await client.post('/api/auth/sign-in/social',json={'provider':'google','callbackURL':'http://testserver/'})
        assert start.status_code==200
        params=parse_qs(urlsplit(start.json()['url']).query)
        assert params['code_challenge_method']==['S256']
        state=params['state'][0]
        finished=await client.get('/api/auth/callback/google',params={'state':state,'code':'synthetic'})
        assert finished.status_code==303
        assert (await client.get('/api/agent/session')).json()['user']['id']=='preserved-id'
        replay=await client.get('/api/auth/callback/google',params={'state':state,'code':'synthetic'})
        assert replay.status_code==400
        await client.post('/api/auth/sign-out',json={})
        assert (await client.get('/api/agent/session')).json()['user'] is None
