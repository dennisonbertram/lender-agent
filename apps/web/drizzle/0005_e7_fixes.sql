ALTER TABLE "relayer_deployments" ADD COLUMN "creator" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "relayer_deployments" ADD COLUMN "estimated_wei" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "relayer_deployments" ADD COLUMN "cost_wei" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "relayer_deployments" ADD COLUMN "lease_expires_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "relayer_deployments_creator_idx" ON "relayer_deployments" USING btree ("creator");--> statement-breakpoint
UPDATE "relayer_deployments" d SET "creator" = c."creator" FROM "safe_creations" c WHERE c."safe_id" = d."safe_id";
