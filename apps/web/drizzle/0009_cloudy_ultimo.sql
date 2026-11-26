ALTER TABLE "alert_state" ADD COLUMN "below_watch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "alert_state" SET "below_watch" = true WHERE "crossed" = true;
