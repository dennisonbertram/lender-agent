ALTER TABLE "reserve_runs" ADD COLUMN "signed_tx" text;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "nonce" bigint;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "executor_address" text;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "link_fingerprint" text;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "authorized_by" text;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "broadcast_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;