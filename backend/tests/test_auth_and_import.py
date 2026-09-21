import json
import sqlite3
import time
import pytest
from authlib.jose import JsonWebKey, JsonWebToken
from backend.app.auth import verify_id_token
from backend.app.domain.draft import fingerprint
from backend.tools.import_d1 import normalize, open_source


def test_oidc_verifies_signature_nonce_audience_expiry_and_email():
    key=JsonWebKey.generate_key('RSA',2048,{'kid':'synthetic'},is_private=True)
    keys={'keys':[key.as_dict(is_private=False)]}
    now=int(time.time())
    base={'iss':'https://accounts.google.com','aud':'synthetic-client','sub':'synthetic-subject','iat':now,'exp':now+3600,'nonce':'expected-nonce','email':'synthetic@example.com','email_verified':True}
    jwt=JsonWebToken(['RS256'])
    sign=lambda data:jwt.encode({'alg':'RS256','kid':'synthetic'},data,key)
    assert verify_id_token(sign(base),keys,'synthetic-client','expected-nonce')['sub']=='synthetic-subject'
    for change in ({'aud':'foreign-client'},{'nonce':'wrong'},{'exp':now-100},{'iss':'https://foreign.example'},{'email_verified':False},{'azp':'foreign-client'},{'aud':['synthetic-client','another']}):
        with pytest.raises(Exception):
            verify_id_token(sign({**base,**change}),keys,'synthetic-client','expected-nonce')
    with pytest.raises(Exception):
        verify_id_token(sign(base),{'keys':[JsonWebKey.generate_key('RSA',2048,{'kid':'synthetic'},is_private=False).as_dict()]},'synthetic-client','expected-nonce')


def make_export(path):
    draft={'baselineId':1,'name':'Synthetic'}; fp=fingerprint(draft)
    db=sqlite3.connect(path)
    db.executescript('''CREATE TABLE user(id TEXT,name TEXT,email TEXT,emailVerified INTEGER,image TEXT,createdAt INTEGER,updatedAt INTEGER);
CREATE TABLE account(id TEXT,accountId TEXT,providerId TEXT,userId TEXT,createdAt INTEGER,updatedAt INTEGER,accessToken TEXT,refreshToken TEXT);
CREATE TABLE agent_projects(id TEXT,user_id TEXT,title TEXT,revision INTEGER,fingerprint TEXT,draft_json TEXT,source_id TEXT,updated_at TEXT);
CREATE TABLE agent_revisions(project_id TEXT,revision INTEGER,fingerprint TEXT,draft_json TEXT,created_at TEXT);
CREATE TABLE agent_runs(id TEXT,user_id TEXT,project_id TEXT,revision INTEGER,mode TEXT,status TEXT,message TEXT,result_json TEXT,created_at TEXT,updated_at TEXT,lease_until INTEGER,day TEXT,llm_calls INTEGER,tool_calls INTEGER,provider_calls INTEGER,cancel_requested INTEGER);
CREATE TABLE session(token TEXT);''')
    db.execute('INSERT INTO user VALUES(?,?,?,?,?,?,?)',('owner','Synthetic','synthetic@example.com',1,None,1,1))
    db.execute('INSERT INTO account VALUES(?,?,?,?,?,?,?,?)',('account','subject','google','owner',1,1,'SYNTHETIC_ACCESS','SYNTHETIC_REFRESH'))
    db.execute('INSERT INTO session VALUES(?)',('SYNTHETIC_SESSION',))
    db.execute('INSERT INTO agent_projects VALUES(?,?,?,?,?,?,?,?)',('project','owner','title',1,fp,json.dumps(draft),None,'now'))
    db.execute('INSERT INTO agent_revisions VALUES(?,?,?,?,?)',('project',1,fp,json.dumps(draft),'now'))
    db.execute('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',('run','owner','project',1,'parts','running','lookup',json.dumps({'partial':True}),'now','now',500,'2026-09-21',1,2,3,0))
    db.commit();db.close()


def test_import_preserves_ids_results_and_omits_credentials(tmp_path):
    source=tmp_path/'export.sqlite';make_export(source)
    before=source.read_bytes(); data=normalize(source)
    assert source.read_bytes()==before
    assert data['user'][0]['id']=='owner'
    assert data['account'][0]['accountId']=='subject'
    assert 'accessToken' not in data['account'][0] and 'refreshToken' not in data['account'][0]
    assert 'session' not in data
    run=data['agent_runs'][0]
    assert run['status']=='cancelled' and run['cancel_requested'] is True
    assert run['result_json']=={'partial':True}
    assert data['agent_projects'][0]['revision']==1


def test_import_rejects_wrong_owners_and_fingerprints(tmp_path):
    source=tmp_path/'export.sqlite';make_export(source)
    with sqlite3.connect(source) as db:
        db.execute("UPDATE agent_projects SET fingerprint='different'")
    with pytest.raises(ValueError,match='fingerprint'):
        normalize(source)
    with sqlite3.connect(source) as db:
        db.execute("UPDATE account SET userId='foreign'")
    with pytest.raises(ValueError,match='identity'):
        normalize(source)


def test_sql_export_cannot_attach_a_filesystem_database(tmp_path):
    source=tmp_path/'export.sql'
    source.write_text("ATTACH DATABASE 'should-not-exist.sqlite' AS other;",encoding='utf-8')
    with pytest.raises(sqlite3.DatabaseError):
        open_source(source)
