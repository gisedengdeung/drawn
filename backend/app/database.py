"""Portable relational schema; PostgreSQL is the production transaction engine."""
from sqlalchemy import (MetaData, Table, Column, String, Text, Integer, BigInteger,
                        Boolean, JSON, Index, UniqueConstraint, text)
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    metadata = MetaData()


m = Base.metadata
users = Table('user', m,
    Column('id', String(128), primary_key=True), Column('name', Text, nullable=False),
    Column('email', Text, nullable=False, unique=True), Column('emailVerified', Boolean, nullable=False, default=False),
    Column('image', Text), Column('createdAt', BigInteger, nullable=False), Column('updatedAt', BigInteger, nullable=False))
accounts = Table('account', m,
    Column('id', String(128), primary_key=True), Column('accountId', Text, nullable=False),
    Column('providerId', String(40), nullable=False), Column('userId', String(128), nullable=False),
    Column('createdAt', BigInteger, nullable=False), Column('updatedAt', BigInteger, nullable=False),
    UniqueConstraint('providerId', 'accountId', name='account_provider_identity'))
sessions = Table('auth_sessions', m,
    Column('token_hash', String(64), primary_key=True), Column('user_id', String(128), nullable=False),
    Column('expires_at', BigInteger, nullable=False), Column('created_at', BigInteger, nullable=False))
oauth_states = Table('oauth_states', m,
    Column('state_hash', String(64), primary_key=True), Column('browser_hash', String(64), nullable=False),
    Column('nonce', Text, nullable=False), Column('verifier', Text, nullable=False),
    Column('callback_url', Text, nullable=False), Column('expires_at', BigInteger, nullable=False))
auth_limits = Table('auth_rate_limits', m,
    Column('key', String(64), primary_key=True), Column('window', BigInteger, nullable=False), Column('count', Integer, nullable=False))
projects = Table('agent_projects', m,
    Column('id', String(36), primary_key=True), Column('user_id', String(128), nullable=False),
    Column('title', Text, nullable=False), Column('revision', Integer, nullable=False),
    Column('fingerprint', Text, nullable=False), Column('draft_json', JSON, nullable=False),
    Column('source_id', String(36)), Column('updated_at', Text, nullable=False))
Index('agent_project_owner', projects.c.user_id, projects.c.updated_at)
revisions = Table('agent_revisions', m,
    Column('project_id', String(36), primary_key=True), Column('revision', Integer, primary_key=True),
    Column('fingerprint', Text, nullable=False), Column('draft_json', JSON, nullable=False), Column('created_at', Text, nullable=False))
usage = Table('agent_usage', m,
    Column('bucket', String(128), primary_key=True), Column('day', String(10), primary_key=True), Column('count', Integer, nullable=False))
runs = Table('agent_runs', m,
    Column('id', String(36), primary_key=True), Column('user_id', String(128), nullable=False),
    Column('project_id', String(36), nullable=False), Column('revision', Integer, nullable=False),
    Column('mode', String(20), nullable=False), Column('status', String(20), nullable=False),
    Column('message', Text, nullable=False), Column('result_json', JSON),
    Column('created_at', Text, nullable=False), Column('updated_at', Text, nullable=False),
    Column('lease_until', BigInteger, nullable=False), Column('day', String(10), nullable=False),
    Column('llm_calls', Integer, nullable=False, default=0), Column('tool_calls', Integer, nullable=False, default=0),
    Column('provider_calls', Integer, nullable=False, default=0), Column('cancel_requested', Boolean, nullable=False, default=False))
Index('agent_one_running', runs.c.user_id, unique=True, postgresql_where=text("status = 'running'"), sqlite_where=text("status = 'running'"))
Index('agent_run_owner', runs.c.user_id, runs.c.project_id, runs.c.created_at)
proposals = Table('agent_proposals', m,
    Column('id', String(36), primary_key=True), Column('user_id', String(128), nullable=False),
    Column('project_id', String(36), nullable=False), Column('run_id', String(36), nullable=False),
    Column('revision', Integer, nullable=False), Column('fingerprint', Text, nullable=False),
    Column('operation', String(40), nullable=False), Column('payload_json', JSON, nullable=False),
    Column('status', String(20), nullable=False, default='proposed'), Column('created_at', Text, nullable=False))
Index('agent_proposal_owner', proposals.c.user_id, proposals.c.project_id)
quotes = Table('agent_quotes', m,
    Column('id', String(36), primary_key=True), Column('user_id', String(128), nullable=False),
    Column('project_id', String(36), nullable=False), Column('run_id', String(36), nullable=False),
    Column('quote_json', JSON, nullable=False), Column('created_at', Text, nullable=False))
Index('agent_quote_owner', quotes.c.user_id, quotes.c.project_id)
gallery = Table('gallery_posts', m,
    Column('id', String(36), primary_key=True), Column('title', Text, nullable=False), Column('author', Text, nullable=False),
    Column('purpose', Text, nullable=False), Column('description', Text, nullable=False), Column('created_at', Text, nullable=False),
    Column('parent_id', String(36)), Column('baseline_id', Integer, nullable=False), Column('num_propellers', Integer, nullable=False),
    Column('num_wings', Integer, nullable=False), Column('reuses', Integer, nullable=False, default=0), Column('draft_json', JSON, nullable=False))


def create_database(url: str):
    engine = create_async_engine(url, pool_pre_ping=True)
    return engine, async_sessionmaker(engine, expire_on_commit=False)
