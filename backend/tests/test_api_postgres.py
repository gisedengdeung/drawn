import asyncio
import copy
import json
from pathlib import Path
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import insert, select
from backend.tests.test_store_postgres import db
from backend.app import auth, database as d
from backend.app.settings import Settings
from backend.app.store import milliseconds, iso
from backend.app.services.dataset import load_design
from backend.app.domain.bom import create_bom_snapshot


@pytest_asyncio.fixture
async def api(db,monkeypatch):
    from backend.app import main
    store,factory=db
    settings=Settings(_env_file=None,database_url='postgresql+asyncpg://unused',app_base_url='http://testserver',session_secret='synthetic-test-secret',google_client_id='synthetic-client',google_client_secret='synthetic-secret',openai_api_key='synthetic-key',aliexpress_app_key='',aliexpress_app_secret='')
    monkeypatch.setattr(main,'create_database',lambda _: (factory.kw['bind'],factory))
    app=main.create_app(settings)
    now=milliseconds()
    async with factory.begin() as s:
        await s.execute(insert(d.users).values(id='api-owner',name='Synthetic',email='api-owner@example.com',emailVerified=True,createdAt=now,updatedAt=now))
        await s.execute(insert(d.sessions).values(token_hash=auth.digest(settings,'synthetic-session'),user_id='api-owner',expires_at=now+600000,created_at=now))
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://testserver',cookies={auth.SESSION_COOKIE:'synthetic-session'}) as client:
            yield client,app,store,settings,factory


def events(response):
    assert response.status_code==200,response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


@pytest.mark.asyncio
async def test_real_model_project_revision_gallery_and_private_access(api):
    client,app,store,settings,factory=api
    ready=await client.get('/api/health/ready')
    assert ready.status_code==200,ready.text
    assert (await client.get('/api/agent/session')).json()['user']['id']=='api-owner'
    draft=load_design(settings,217)
    created=await client.post('/api/projects',json={'title':'Synthetic project','draft':draft})
    assert created.status_code==201,created.text
    project=created.json()
    changed=copy.deepcopy(draft);changed['payload']['mass']+=0.1
    saved=await client.patch('/api/projects/'+project['id'],json={'expectedRevision':1,'draft':changed})
    assert saved.status_code==200,saved.text
    assert saved.json()['revision']==2
    stale=await client.patch('/api/projects/'+project['id'],json={'expectedRevision':1,'draft':draft})
    assert stale.status_code==409
    restored=await client.post('/api/projects/'+project['id']+'/restore',json={'expectedRevision':2,'revision':1})
    assert restored.status_code==200 and restored.json()['revision']==3
    shared=await client.post('/api/gallery',json={'title':'Synthetic','author':'Synthetic','description':'Synthetic test','purpose':'연구·실험','allowReuse':True,'draft':draft})
    assert shared.status_code==201,shared.text
    post_id=shared.json()['id']
    assert (await client.get('/api/gallery',params={'id':post_id})).json()['draft']==draft
    assert (await client.post('/api/gallery',json={'action':'reuse','id':post_id})).json()['reuses']==1
    forged=await client.patch('/api/projects/'+project['id'],headers={'Origin':'https://foreign.example'},json={'expectedRevision':3,'draft':draft})
    assert forged.status_code==403
    client.cookies.clear()
    assert (await client.get('/api/projects/'+project['id'])).status_code==401
    assert (await client.get('/api/gallery',params={'id':post_id})).status_code==200


@pytest.mark.asyncio
async def test_parts_ndjson_checkpoint_quote_and_single_search(api,monkeypatch):
    client,app,store,settings,factory=api
    from backend.app.services import runner,parts
    calls=[]
    async def provider(item,settings,consume_budget,cancel_event,**kwargs):
        await consume_budget('provider');calls.append(item['id'])
        if kwargs.get('allow_ai'):
            await consume_budget('ai')
        return dict(itemId=item['id'],status='ok',warnings=[],retrievedAt=iso(),offers=[dict(id='100000000001:unverified',productId='100000000001',title='Synthetic listing',url='https://www.aliexpress.com/item/100000000001.html',promotionUrl=None,priceKind='listing',optionVerified=False,packQuantity=None,packPrice=1234,currency='KRW',match='needs_review',retrievedAt=iso())])
    monkeypatch.setattr(runner,'search_parts',provider);monkeypatch.setattr(parts,'search_parts',provider)
    draft=load_design(settings,217)
    project=(await client.post('/api/projects',json={'title':'Parts','draft':draft})).json()
    result=events(await client.post('/api/agent/run',json={'projectId':project['id'],'revision':1,'mode':'parts','message':'부품 찾아줘'}))
    assert result[0]['type']=='start' and result[-1]['type']=='result',result
    assert any(e['type']=='progress' for e in result)
    run_id=result[0]['runId'];quote=result[-1]['result']['quote']
    assert len(calls)==len(quote['lines'])
    assert all(line['selectedOfferId'] is None for line in quote['lines'])
    persisted=(await client.get('/api/agent/runs/'+run_id)).json()
    assert persisted['status']=='completed' and persisted['result']['quote']==quote
    line=quote['lines'][0]
    saved=await client.post('/api/projects/'+project['id']+'/quotes',json={'runId':run_id,'selections':[{'itemId':line['item']['id'],'offerId':line['result']['offers'][0]['id']}]})
    assert saved.status_code==201,saved.text
    assert len((await client.get('/api/projects/'+project['id']+'/quotes')).json()['quotes'])==1
    forged=await client.post('/api/projects/'+project['id']+'/quotes',json={'runId':run_id,'selections':[{'itemId':line['item']['id'],'offerId':'fabricated'}]})
    assert forged.status_code==400
    searched=await client.post('/api/parts/search',json={'projectId':project['id'],'revision':1,'item':line['item'],'country':'KR','currency':'KRW'})
    assert searched.status_code==200 and searched.json()['itemId']==line['item']['id'],searched.text
    async with factory() as s:
        budget = (await s.execute(select(d.runs.c.llm_calls, d.runs.c.provider_calls).where(d.runs.c.project_id == project['id']).order_by(d.runs.c.created_at.desc()).limit(1))).one()
        assert budget.llm_calls == 1 and budget.provider_calls == 1


@pytest.mark.asyncio
async def test_qa_model_evidence_optimize_apply_and_cancel(api,monkeypatch):
    client,app,store,settings,factory=api
    from backend.app.services import runner
    class Model:
        def __init__(self,settings,charge):self.charge=charge
        async def intent(self,message):
            await self.charge()
            return dict(objective='hover',massLimit=None,powerLimit=None,topologyLocked=True,speed=10,compareCost=False)
        async def explain(self,message,evidence,warnings):
            await self.charge();return '확인된 설계 근거입니다. [e1]'
        async def close(self):pass
    monkeypatch.setattr(runner,'AgentModel',Model)
    draft=load_design(settings,217)
    project=(await client.post('/api/projects',json={'title':'QA','draft':draft})).json()
    qa=events(await client.post('/api/agent/run',json={'projectId':project['id'],'revision':1,'mode':'qa','message':'10 m/s 성능 알려줘'}))
    assert qa[-1]['type']=='result',qa
    predictions=[e for e in qa[-1]['result']['evidence'] if e['kind']=='model-prediction']
    assert predictions and 'modelVersion' in json.loads(predictions[0]['text'])
    optimized=events(await client.post('/api/agent/run',json={'projectId':project['id'],'revision':1,'mode':'optimize','message':'체공 시간을 개선해줘'}))
    assert optimized[-1]['type']=='result',optimized
    proposals=optimized[-1]['result']['proposals']
    assert proposals
    applied=await client.post('/api/design-proposals/'+proposals[0]['id']+'/apply',json={'expectedRevision':1})
    assert applied.status_code==200,applied.text
    assert (await client.post('/api/design-proposals/'+proposals[0]['id']+'/apply',json={'expectedRevision':1})).status_code==409
    entered=asyncio.Event()
    async def waiting(ctx):
        entered.set()
        await asyncio.sleep(60)
        raise AssertionError('Cancelled work must not finish')
    monkeypatch.setattr(runner,'execute_run',waiting)
    pending=asyncio.create_task(client.post('/api/agent/run',json={'projectId':project['id'],'revision':applied.json()['revision'],'mode':'qa','message':'대기'}))
    await asyncio.wait_for(entered.wait(),10)
    history=(await client.get('/api/agent/runs',params={'projectId':project['id']})).json()['runs']
    running=next(row for row in history if row['status']=='running')
    cancelled=await client.post('/api/agent/runs/'+running['id']+'/cancel',json={})
    assert cancelled.json()=={'cancelled':True}
    outcome=events(await asyncio.wait_for(pending,10))
    assert outcome[-1]['type']=='error'
    assert (await client.get('/api/agent/runs/'+running['id'])).json()['status']=='cancelled'
