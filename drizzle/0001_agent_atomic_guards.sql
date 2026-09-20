CREATE TRIGGER agent_project_initial_revision AFTER INSERT ON agent_projects BEGIN
 INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(NEW.id,NEW.revision,NEW.fingerprint,NEW.draft_json,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER agent_project_revision AFTER UPDATE OF revision ON agent_projects WHEN NEW.revision<>OLD.revision BEGIN
 INSERT INTO agent_revisions(project_id,revision,fingerprint,draft_json,created_at) VALUES(NEW.id,NEW.revision,NEW.fingerprint,NEW.draft_json,NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER agent_run_quota BEFORE INSERT ON agent_runs BEGIN
 SELECT CASE WHEN COALESCE((SELECT count FROM agent_usage WHERE bucket=NEW.user_id AND day=NEW.day),0)>=20 THEN RAISE(ABORT,'user_daily_limit') END;
 SELECT CASE WHEN COALESCE((SELECT count FROM agent_usage WHERE bucket='*' AND day=NEW.day),0)>=200 THEN RAISE(ABORT,'global_daily_limit') END;
END;
--> statement-breakpoint
CREATE TRIGGER agent_run_charge AFTER INSERT ON agent_runs BEGIN
 INSERT INTO agent_usage(bucket,day,count) VALUES(NEW.user_id,NEW.day,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1;
 INSERT INTO agent_usage(bucket,day,count) VALUES('*',NEW.day,1) ON CONFLICT(bucket,day) DO UPDATE SET count=count+1;
END;
