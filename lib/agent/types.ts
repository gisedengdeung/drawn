import type { DesignDraft, WorkspaceView } from '../drawn-types';
import type { BomSnapshot, QuoteLine } from '../parts/types';
export type AgentMode = 'parts' | 'optimize' | 'qa';
export type Project = {
  id: string;
  title: string;
  revision: number;
  fingerprint: string;
  draft: DesignDraft;
  sourceId: string | null;
  updatedAt: string;
};
export type AgentContext = {
  projectId: string;
  revision: number;
  fingerprint: string;
  datasetVersion?: string;
};
export type Evidence = {
  id: string;
  kind:
    | 'dataset-output'
    | 'dataset-trim'
    | 'draft-estimate'
    | 'supplier-offer'
    | 'document'
    | 'user-input';
  title: string;
  text: string;
  target?: { view: WorkspaceView; designId?: number; parameterId?: string };
};
export type AgentProposal = {
  id: string;
  title: string;
  operation: 'select_dataset_design' | 'patch_draft';
  changes: Array<{
    targetId: string;
    before: number;
    after: number;
    unit: string;
  }>;
  candidateDesignId?: number;
  metrics?: Record<string, number>;
  reason: string;
};
export type AgentResult = {
  answer: string;
  evidence: Evidence[];
  proposals: AgentProposal[];
  quote?: { snapshot: BomSnapshot; lines: QuoteLine[] };
  warnings: string[];
  context: AgentContext;
};
export type AgentRun = {
  id: string;
  projectId: string;
  revision: number;
  mode: AgentMode;
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  message: string;
  result: AgentResult | null;
  createdAt: string;
};
export type RunEvent = {
  type: 'start' | 'progress' | 'result' | 'error';
  runId?: string;
  message?: string;
  result?: AgentResult;
};
export type AgentSession = {
  configured: boolean;
  user: { id: string; name: string; email: string } | null;
  missing: string[];
  usage: {
    used: number;
    limit: number;
    globalRemaining: number;
    resetAt: string;
  } | null;
};
