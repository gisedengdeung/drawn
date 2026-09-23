"""Initial PostgreSQL service schema. Legacy identities and entity IDs stay intact."""
from alembic import op
import sqlalchemy as sa

revision = '0001_fastapi'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('user', sa.Column('id',sa.String(128),primary_key=True),sa.Column('name',sa.Text,nullable=False),sa.Column('email',sa.Text,nullable=False,unique=True),sa.Column('emailVerified',sa.Boolean,nullable=False),sa.Column('image',sa.Text),sa.Column('createdAt',sa.BigInteger,nullable=False),sa.Column('updatedAt',sa.BigInteger,nullable=False))
    op.create_table('account',sa.Column('id',sa.String(128),primary_key=True),sa.Column('accountId',sa.Text,nullable=False),sa.Column('providerId',sa.String(40),nullable=False),sa.Column('userId',sa.String(128),nullable=False),sa.Column('createdAt',sa.BigInteger,nullable=False),sa.Column('updatedAt',sa.BigInteger,nullable=False),sa.UniqueConstraint('providerId','accountId',name='account_provider_identity'))
    op.create_table('auth_sessions',sa.Column('token_hash',sa.String(64),primary_key=True),sa.Column('user_id',sa.String(128),nullable=False),sa.Column('expires_at',sa.BigInteger,nullable=False),sa.Column('created_at',sa.BigInteger,nullable=False))
    op.create_table('oauth_states',sa.Column('state_hash',sa.String(64),primary_key=True),sa.Column('browser_hash',sa.String(64),nullable=False),sa.Column('nonce',sa.Text,nullable=False),sa.Column('verifier',sa.Text,nullable=False),sa.Column('callback_url',sa.Text,nullable=False),sa.Column('expires_at',sa.BigInteger,nullable=False))
    op.create_table('auth_rate_limits',sa.Column('key',sa.String(64),primary_key=True),sa.Column('window',sa.BigInteger,nullable=False),sa.Column('count',sa.Integer,nullable=False))
    op.create_table('agent_projects',sa.Column('id',sa.String(36),primary_key=True),sa.Column('user_id',sa.String(128),nullable=False),sa.Column('title',sa.Text,nullable=False),sa.Column('revision',sa.Integer,nullable=False),sa.Column('fingerprint',sa.Text,nullable=False),sa.Column('draft_json',sa.JSON,nullable=False),sa.Column('source_id',sa.String(36)),sa.Column('updated_at',sa.Text,nullable=False))
    op.create_index('agent_project_owner','agent_projects',['user_id','updated_at'])
    op.create_table('agent_revisions',sa.Column('project_id',sa.String(36),primary_key=True),sa.Column('revision',sa.Integer,primary_key=True),sa.Column('fingerprint',sa.Text,nullable=False),sa.Column('draft_json',sa.JSON,nullable=False),sa.Column('created_at',sa.Text,nullable=False))
    op.create_table('agent_usage',sa.Column('bucket',sa.String(128),primary_key=True),sa.Column('day',sa.String(10),primary_key=True),sa.Column('count',sa.Integer,nullable=False))
    op.create_table('agent_runs',sa.Column('id',sa.String(36),primary_key=True),sa.Column('user_id',sa.String(128),nullable=False),sa.Column('project_id',sa.String(36),nullable=False),sa.Column('revision',sa.Integer,nullable=False),sa.Column('mode',sa.String(20),nullable=False),sa.Column('status',sa.String(20),nullable=False),sa.Column('message',sa.Text,nullable=False),sa.Column('result_json',sa.JSON),sa.Column('created_at',sa.Text,nullable=False),sa.Column('updated_at',sa.Text,nullable=False),sa.Column('lease_until',sa.BigInteger,nullable=False),sa.Column('day',sa.String(10),nullable=False),sa.Column('llm_calls',sa.Integer,nullable=False),sa.Column('tool_calls',sa.Integer,nullable=False),sa.Column('provider_calls',sa.Integer,nullable=False),sa.Column('cancel_requested',sa.Boolean,nullable=False))
    op.create_index('agent_one_running','agent_runs',['user_id'],unique=True,postgresql_where=sa.text("status = 'running'"))
    op.create_index('agent_run_owner','agent_runs',['user_id','project_id','created_at'])
    op.create_table('agent_proposals',sa.Column('id',sa.String(36),primary_key=True),sa.Column('user_id',sa.String(128),nullable=False),sa.Column('project_id',sa.String(36),nullable=False),sa.Column('run_id',sa.String(36),nullable=False),sa.Column('revision',sa.Integer,nullable=False),sa.Column('fingerprint',sa.Text,nullable=False),sa.Column('operation',sa.String(40),nullable=False),sa.Column('payload_json',sa.JSON,nullable=False),sa.Column('status',sa.String(20),nullable=False),sa.Column('created_at',sa.Text,nullable=False))
    op.create_index('agent_proposal_owner','agent_proposals',['user_id','project_id'])
    op.create_table('agent_quotes',sa.Column('id',sa.String(36),primary_key=True),sa.Column('user_id',sa.String(128),nullable=False),sa.Column('project_id',sa.String(36),nullable=False),sa.Column('run_id',sa.String(36),nullable=False),sa.Column('quote_json',sa.JSON,nullable=False),sa.Column('created_at',sa.Text,nullable=False))
    op.create_index('agent_quote_owner','agent_quotes',['user_id','project_id'])
    op.create_table('gallery_posts',sa.Column('id',sa.String(36),primary_key=True),sa.Column('title',sa.Text,nullable=False),sa.Column('author',sa.Text,nullable=False),sa.Column('purpose',sa.Text,nullable=False),sa.Column('description',sa.Text,nullable=False),sa.Column('created_at',sa.Text,nullable=False),sa.Column('parent_id',sa.String(36)),sa.Column('baseline_id',sa.Integer,nullable=False),sa.Column('num_propellers',sa.Integer,nullable=False),sa.Column('num_wings',sa.Integer,nullable=False),sa.Column('reuses',sa.Integer,nullable=False),sa.Column('draft_json',sa.JSON,nullable=False))


def downgrade():
    for name in ('gallery_posts','agent_quotes','agent_proposals','agent_runs','agent_usage','agent_revisions','agent_projects','auth_rate_limits','oauth_states','auth_sessions','account','user'):
        op.drop_table(name)
