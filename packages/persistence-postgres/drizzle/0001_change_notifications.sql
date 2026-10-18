CREATE OR REPLACE FUNCTION ct_notify_run() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    PERFORM pg_notify('ct_runs', NEW.id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER runs_notify AFTER INSERT OR UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION ct_notify_run();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ct_notify_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('ct_jobs', 'deleted:' || OLD.id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('ct_jobs', 'created:' || NEW.id);
  ELSIF NEW.version IS DISTINCT FROM OLD.version
    OR NEW.next_fire_at IS DISTINCT FROM OLD.next_fire_at
    OR NEW.last_success_at IS DISTINCT FROM OLD.last_success_at
    OR NEW.consecutive_failures IS DISTINCT FROM OLD.consecutive_failures
    OR NEW.sla_breached_at IS DISTINCT FROM OLD.sla_breached_at THEN
    PERFORM pg_notify('ct_jobs', 'updated:' || NEW.id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER jobs_notify AFTER INSERT OR UPDATE OR DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION ct_notify_job();
