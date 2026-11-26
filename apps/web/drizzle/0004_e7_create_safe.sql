CREATE TABLE "relayer_deployments" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "safe_creations" (
	"safe_id" integer PRIMARY KEY NOT NULL,
	"creator" text NOT NULL,
	"salt_index" integer NOT NULL,
	"consent_signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relayer_deployments" ADD CONSTRAINT "relayer_deployments_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_creations" ADD CONSTRAINT "safe_creations_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relayer_deployments_safe_chain_idx" ON "relayer_deployments" USING btree ("safe_id","chain_id");--> statement-breakpoint
CREATE INDEX "relayer_deployments_day_idx" ON "relayer_deployments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "safe_creations_creator_idx" ON "safe_creations" USING btree ("creator","salt_index");