import os
from pathlib import Path
from uuid import uuid4
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from alembic.config import Config
from alembic import command
from alembic.migration import MigrationContext
from alembic.autogenerate import compare_metadata
from backend.app.database import Base


@pytest.mark.asyncio
async def test_alembic_initial_schema_matches_application_and_upgrade_is_repeatable():
    url=os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('TEST_DATABASE_URL required')
    schema='test_migration_'+uuid4().hex
    engine=create_async_engine(url)
    config=Config(str(Path(__file__).resolve().parents[1]/'alembic.ini'))
    try:
        async with engine.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            await connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
            def migrate(sync):
                config.attributes['connection']=sync
                command.upgrade(config,'head')
                command.upgrade(config,'head')
                differences=compare_metadata(MigrationContext.configure(sync),Base.metadata)
                assert differences==[],differences
            await connection.run_sync(migrate)
            assert await connection.scalar(text('SELECT version_num FROM alembic_version'))=='0001_fastapi'
    finally:
        async with engine.begin() as connection:
            await connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()
