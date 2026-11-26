ALTER TABLE "reserve_runs" ADD COLUMN "email_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "email_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "email_sent_to" jsonb DEFAULT '[]'::jsonb NOT NULL;