import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified').notNull().default(0),
  image: text('image'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull(),
});
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull(),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt'),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});
export const rateLimit = sqliteTable('rateLimit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('lastRequest').notNull(),
});

export const projects = sqliteTable(
  'agent_projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    draft: text('draft_json').notNull(),
    sourceId: text('source_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('agent_project_owner').on(t.userId, t.updatedAt)],
);
export const revisions = sqliteTable(
  'agent_revisions',
  {
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    draft: text('draft_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.revision] })],
);
export const usage = sqliteTable(
  'agent_usage',
  {
    bucket: text('bucket').notNull(),
    day: text('day').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.day] })],
);
export const runs = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    message: text('message').notNull(),
    result: text('result_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    leaseUntil: integer('lease_until').notNull(),
    day: text('day').notNull(),
    llmCalls: integer('llm_calls').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    providerCalls: integer('provider_calls').notNull().default(0),
    cancelRequested: integer('cancel_requested').notNull().default(0),
  },
  (t) => [
    uniqueIndex('agent_one_running')
      .on(t.userId)
      .where(sql`status = 'running'`),
    index('agent_run_owner').on(t.userId, t.projectId, t.createdAt),
  ],
);
export const proposals = sqliteTable(
  'agent_proposals',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    operation: text('operation').notNull(),
    payload: text('payload_json').notNull(),
    status: text('status').notNull().default('proposed'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('agent_proposal_owner').on(t.userId, t.projectId)],
);
export const quotes = sqliteTable(
  'agent_quotes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    quote: text('quote_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('agent_quote_owner').on(t.userId, t.projectId)],
);

// Sites hosts gallery and private Agent tables in the declared logical D1 binding.
export const galleryPosts = sqliteTable('gallery_posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  purpose: text('purpose').notNull(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
  parentId: text('parent_id'),
  baselineId: integer('baseline_id').notNull(),
  numPropellers: integer('num_propellers').notNull(),
  numWings: integer('num_wings').notNull(),
  reuses: integer('reuses').notNull().default(0),
  draft: text('draft_json').notNull(),
});
