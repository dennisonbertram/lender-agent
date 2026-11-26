ALTER TABLE "proposals" ADD COLUMN "submission_attempted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "proposals"
SET "submission_attempted_at" = "updated_at"
WHERE "submission_attempted_at" IS NULL
  AND "safe_tx_hash" IS NOT NULL
  AND "stage" IN ('sending', 'queued', 'stopped', 'replaced', 'rejected', 'stale');
