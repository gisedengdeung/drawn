-- Compound trigger DDL failed in the first hosted deployment before Worker publication.
-- Ownership, history and quotas now use atomic guarded D1 batches in application code.
-- Remove any partially created triggers. Tables and stored rows are preserved.
DROP TRIGGER IF EXISTS agent_project_initial_revision;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_project_revision;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_run_quota;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_run_charge;
