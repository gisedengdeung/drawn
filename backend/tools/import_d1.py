"""Validate/import an explicit D1 SQLite or SQL export. Default: dry run.

python -m backend.tools.import_d1 --source export.sqlite [--gallery-source gallery.sql]
Add --apply with DATABASE_URL set only after reviewing the dry-run counts.
No remote access and no source writes; sessions and OAuth credentials are never copied.
"""
import argparse
import asyncio
import json
import os
import sqlite3
from pathlib import Path
from sqlalchemy import select, insert, func
from sqlalchemy.exc import SQLAlchemyError
from backend.app import database as d

TABLES = ['user','account','agent_projects','agent_revisions','agent_usage','agent_runs','agent_proposals','agent_quotes','gallery_posts']


def open_source(path):
    path = Path(path).resolve(strict=True)
    if path.suffix.lower() == '.sql':
        db = sqlite3.connect(':memory:')
        def authorize(action, first, second, *_):
            if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_PRAGMA and str(first).lower() not in ('foreign_keys','defer_foreign_keys'):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        db.set_authorizer(authorize)
        db.executescript(path.read_text(encoding='utf-8-sig'))
    else:
        db = sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    return db


def read_rows(path):
    db = open_source(path)
    try:
        available = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {name:[dict(r) for r in db.execute('SELECT * FROM "'+name+'"')] if name in available else [] for name in TABLES}
    finally:
        db.close()


def normalize(source, gallery_source=None):
    data=read_rows(source)
    if gallery_source:
        existing={row['id']:row for row in data['gallery_posts']}
        for row in read_rows(gallery_source)['gallery_posts']:
            if row['id'] in existing and row != existing[row['id']]:
                raise ValueError('Conflicting gallery IDs between source databases')
            existing[row['id']]=row
        data['gallery_posts']=list(existing.values())
    for name,rows in data.items():
        table=d.Base.metadata.tables[name]
        names=set(table.c.keys())
        for row in rows:
            for key in list(row):
                if key not in names:
                    del row[key]  # Includes legacy OAuth access/refresh/id tokens.
            for key in names:
                if key.endswith('_json') and isinstance(row.get(key),str):
                    row[key]=json.loads(row[key])
            if name=='user':
                row['emailVerified']=bool(row.get('emailVerified'))
            if name=='agent_runs':
                row['cancel_requested']=bool(row.get('cancel_requested'))
                if row['status']=='running':
                    row['status']='cancelled';row['cancel_requested']=True
            json.dumps(row,allow_nan=False)
            missing=[c.name for c in table.c if not c.nullable and c.name not in row and c.default is None]
            if missing:
                raise ValueError(f'{name}: required columns missing: {missing}')
    validate(data)
    return data


def validate(data):
    from backend.app.domain.draft import fingerprint
    ids={name:{r['id'] for r in rows} for name,rows in data.items() if rows and 'id' in rows[0]}
    users=ids.get('user',set()); projects={r['id']:r for r in data['agent_projects']}; runs={r['id']:r for r in data['agent_runs']}
    for name,rows in data.items():
        table=d.Base.metadata.tables[name];seen=set()
        for row in rows:
            key=tuple(row[c.name] for c in table.primary_key)
            if key in seen:
                raise ValueError(f'{name}: duplicate primary key')
            seen.add(key)
            owner=row.get('user_id',row.get('userId'))
            if owner is not None and owner not in users:
                raise ValueError(f'{name}: missing user identity')
            if 'project_id' in row and row['project_id'] not in projects:
                raise ValueError(f'{name}: missing project')
            if 'project_id' in row and owner is not None and projects[row['project_id']]['user_id'] != owner:
                raise ValueError(f'{name}: project ownership mismatch')
            if 'run_id' in row and row['run_id'] not in runs:
                raise ValueError(f'{name}: missing run')
            if 'run_id' in row and (runs[row['run_id']]['user_id'] != owner or runs[row['run_id']]['project_id'] != row['project_id']):
                raise ValueError(f'{name}: run ownership mismatch')
            if name in ('agent_projects','agent_revisions') and fingerprint(row['draft_json']) != row['fingerprint']:
                raise ValueError(f'{name}: fingerprint mismatch; resolve serialization compatibility before import')
    histories={(r['project_id'],r['revision']):r for r in data['agent_revisions']}
    for project in projects.values():
        current=histories.get((project['id'],project['revision']))
        if current is None or current['fingerprint']!=project['fingerprint'] or current['draft_json']!=project['draft_json']:
            raise ValueError('Project current revision does not match stored history')
    for row in data['gallery_posts']:
        if row.get('parent_id') and row['parent_id'] not in ids.get('gallery_posts',set()):
            raise ValueError('Gallery parent missing')
    identities=[(row['providerId'],row['accountId']) for row in data['account']]
    if len(identities)!=len(set(identities)):
        raise ValueError('Duplicate provider account identities')
    for row in data['agent_usage']:
        if row['bucket']!='*' and row['bucket'] not in users:
            raise ValueError('Usage bucket missing user identity')


async def apply(data,url):
    if not url.startswith('postgresql+asyncpg://'):
        raise ValueError('PostgreSQL asyncpg DATABASE_URL required')
    engine,factory=d.create_database(url)
    try:
        async with factory.begin() as session:
            # An advisory transaction lock prevents two importer processes racing the empty check.
            from sqlalchemy import text
            await session.execute(text('SELECT pg_advisory_xact_lock(1860295461)'))
            for name in d.Base.metadata.tables:
                if await session.scalar(select(func.count()).select_from(d.Base.metadata.tables[name])):
                    raise ValueError('Target must be an empty migrated database; no existing rows are overwritten')
            for name in TABLES:
                table=d.Base.metadata.tables[name];rows=data[name]
                for start in range(0,len(rows),500):
                    await session.execute(insert(table),rows[start:start+500])
            for name in TABLES:
                actual=await session.scalar(select(func.count()).select_from(d.Base.metadata.tables[name]))
                if actual!=len(data[name]):
                    raise ValueError('Post-import row count mismatch')
    finally:
        await engine.dispose()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    parser.add_argument('--gallery-source')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    try:
        data=normalize(args.source,args.gallery_source)
        if args.apply:
            from backend.app.settings import Settings
            url=os.getenv('DATABASE_URL') or Settings().database_url
            if not url:
                raise ValueError('DATABASE_URL must be configured before applying an import')
            asyncio.run(apply(data,url))
        print(json.dumps({'mode':'imported' if args.apply else 'dry-run','counts':{name:len(rows) for name,rows in data.items()},'sessionsImported':False,'oauthCredentialsImported':False}))
    except SQLAlchemyError:
        parser.exit(1, 'Database import failed; the transaction was rolled back. Check connectivity and the migrated schema.\n')
    except (ValueError,KeyError,sqlite3.Error) as error:
        parser.exit(1,'Import validation failed: '+str(error)+'\n')


if __name__=='__main__':
    main()
