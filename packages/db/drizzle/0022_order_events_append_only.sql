-- Make the chain of custody append-only, in the DATABASE.
--
-- HAND-WRITTEN, which this repo otherwise forbids: migrations are generated from
-- schema.ts so the database cannot drift from the types. Drizzle cannot express a
-- trigger, and the alternative — leaving append-only as a comment — is exactly the
-- defect being fixed. `CLAUDE.prd.md` claimed "append-only audit trail" as BUILT while
-- there were zero triggers, revoked grants or row-level policies across the whole
-- migration history, and any UPDATE or DELETE simply worked.
--
-- WHY A TRIGGER RATHER THAN REVOKED GRANTS. A grant protects against a role; a trigger
-- protects against everyone, including the owner and anyone who later connects with a
-- different credential. This table is the artifact a procurement reviewer asks us to
-- prove is tamper-evident, so the guarantee should not depend on which connection string
-- was used.
--
-- DELETE IS NOT FORBIDDEN — IT IS DATED. A blanket refusal would make the six-year
-- retention policy unenforceable in the one direction that also matters: holding PHI
-- forever with no lawful basis. So the trigger reads `retain_until` and permits a delete
-- only once it has passed, which puts the retention rule in Postgres instead of in
-- application code that has to be remembered.

CREATE OR REPLACE FUNCTION order_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'order_events is append-only: an audit row cannot be modified (order %, id %)',
      OLD.order_id, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.retain_until > now() THEN
      RAISE EXCEPTION
        'order_events row is retained until % and cannot be deleted (order %, id %)',
        OLD.retain_until, OLD.order_id, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_events_append_only_trigger ON order_events;

CREATE TRIGGER order_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_events_append_only();
