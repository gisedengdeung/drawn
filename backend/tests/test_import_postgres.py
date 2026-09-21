"""Nonempty export import and failed-import rollback against real PostgreSQL."""
import copy
import json
import sqlite3
import pytest
from sqlalchemy import select, func
from backend.tests.test_store_postgres import db
from backend.tests.test_auth_and_import import make_export
from backend.app import database as d
from backend.tools import import_d1


def complete_export(path):
    make_export(path)
    with sqlite3.connect(path) as db:
        draft,fp=db.execute('SELECT draft_json,fingerprint FROM agent_projects').fetchone()
        quote={'snapshot':{'fingerprint':fp},'lines':[]}
        db.executescript('''CREATE TABLE agent_usage(bucket TEXT,day TEXT,count INTEGER);
CREATE TABLE agent_proposals(id TEXT,user_id TEXT,project_id TEXT,run_id TEXT,revision INTEGER,fingerprint TEXT,operation TEXT,payload_json TEXT,status TEXT,created_at TEXT);
CREATE TABLE agent_quotes(id TEXT,user_id TEXT,project_id TEXT,run_id TEXT,quote_json TEXT,created_at TEXT);
CREATE TABLE gallery_posts(id TEXT,title TEXT,author TEXT,purpose TEXT,description TEXT,created_at TEXT,parent_id TEXT,baseline_id INTEGER,num_propellers INTEGER,num_wings INTEGER,reuses INTEGER,draft_json TEXT);''')
        db.execute('INSERT INTO agent_usage VALUES(?,?,?)',('owner','2026-09-21',7))
        db.execute('INSERT INTO agent_usage VALUES(?,?,?)',('*','2026-09-21',21))
        db.execute('INSERT INTO agent_proposals VALUES(?,?,?,?,?,?,?,?,?,?)',('proposal','owner','project','run',1,fp,'patch_draft',json.dumps({'changes':[],'locks':[]}),'proposed','now'))
        db.execute('INSERT INTO agent_quotes VALUES(?,?,?,?,?,?)',('quote','owner','project','run',json.dumps(quote),'now'))
        db.execute('INSERT INTO gallery_posts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',('gallery','Synthetic','Synthetic','연구·실험','Synthetic test','now',None,1,4,0,2,draft))
        db.execute("UPDATE agent_projects SET source_id='gallery'")
        db.execute('UPDATE agent_runs SET result_json=?',(json.dumps({'quote':quote,'evidence':[{'kind':'dataset-output'}]}),))


@pytest.mark.asyncio
async def test_full_nonempty_import_preserves_all_entity_ids_and_rejects_overwrite(db,tmp_path,monkeypatch):
    store,factory=db
    source=tmp_path/'export.sqlite';complete_export(source)
    source_bytes=source.read_bytes()
    normalized=import_d1.normalize(source)
    monkeypatch.setattr(d,'create_database',lambda _: (factory.kw['bind'],factory))
    await import_d1.apply(normalized,'postgresql+asyncpg://synthetic')
    async with factory() as s:
        for name,rows in normalized.items():
            actual=(await s.execute(select(d.Base.metadata.tables[name]))).mappings().all()
            assert [dict(row) for row in actual]==rows,name
        assert await s.scalar(select(func.count()).select_from(d.sessions))==0
        assert await s.scalar(select(func.count()).select_from(d.oauth_states))==0
    assert source.read_bytes()==source_bytes
    assert (await store.get_project('owner','project'))['sourceId']=='gallery'
    assert (await store.get_run('owner','run'))['status']=='cancelled'
    with pytest.raises(ValueError,match='empty'):
        await import_d1.apply(normalized,'postgresql+asyncpg://synthetic')
    async with factory() as s:
        assert await s.scalar(select(func.count()).select_from(d.users))==1


@pytest.mark.asyncio
async def test_database_constraint_failure_rolls_back_the_entire_import(db,tmp_path,monkeypatch):
    store,factory=db
    source=tmp_path/'export.sqlite';complete_export(source)
    normalized=import_d1.normalize(source)
    # The second account violates the provider-subject unique constraint after users were inserted.
    duplicated=copy.deepcopy(normalized['account'][0]);duplicated['id']='conflicting-account'
    normalized['account'].append(duplicated)
    monkeypatch.setattr(d,'create_database',lambda _: (factory.kw['bind'],factory))
    with pytest.raises(Exception):
        await import_d1.apply(normalized,'postgresql+asyncpg://synthetic')
    async with factory() as s:
        for table in d.Base.metadata.tables.values():
            assert await s.scalar(select(func.count()).select_from(table))==0,table.name
