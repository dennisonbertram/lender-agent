CREATE TABLE "moves" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"from_chain" integer NOT NULL,
	"to_chain" integer NOT NULL,
	"asset" text NOT NULL,
	"status" text NOT NULL,
	"quote" jsonb NOT NULL,
	"spec" jsonb NOT NULL,
	"proposal_id" text,
	"source_tx_hash" text,
	"dest_tx_hash" text,
	"quoted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"delayed_at" timestamp with time zone,
	"received_raw" text,
	"attributed_raw" text DEFAULT '0' NOT NULL,
	"detail" text,
	"replaced_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reserve_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"main_safe_id" integer NOT NULL,
	"reserve_safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"roles_address" text NOT NULL,
	"executor_address" text NOT NULL,
	"salt_nonce" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"daily_limit" text NOT NULL,
	"trigger_hf" double precision NOT NULL,
	"setup_proposal_id" text,
	"from_block" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reserve_policy_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"kind" text NOT NULL,
	"new_trigger" double precision,
	"new_limit_raw" text,
	"tx" jsonb NOT NULL,
	"safe_tx_hash" text NOT NULL,
	"prev_trigger" double precision DEFAULT 0 NOT NULL,
	"prev_limit_raw" text DEFAULT '0' NOT NULL,
	"from_block" text DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reserve_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"requested_raw" text NOT NULL,
	"paid_raw" text,
	"tx_hash" text,
	"hf_before" double precision NOT NULL,
	"hf_after" double precision,
	"allowance_left_raw" text,
	"balance_left_raw" text,
	"origin" text DEFAULT 'auto' NOT NULL,
	"error" text,
	"rest_draft_id" text,
	"email_planned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reserve_runs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "rule_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" integer NOT NULL,
	"outcome" text NOT NULL,
	"line" text NOT NULL,
	"draft_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_runs_alert_id_unique" UNIQUE("alert_id")
);
--> statement-breakpoint
CREATE TABLE "standing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"option" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_links" ADD CONSTRAINT "reserve_links_main_safe_id_safes_id_fk" FOREIGN KEY ("main_safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_links" ADD CONSTRAINT "reserve_links_reserve_safe_id_safes_id_fk" FOREIGN KEY ("reserve_safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_policy_changes" ADD CONSTRAINT "reserve_policy_changes_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reserve_runs" ADD CONSTRAINT "reserve_runs_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_runs" ADD CONSTRAINT "rule_runs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moves_safe_idx" ON "moves" USING btree ("safe_id","status");--> statement-breakpoint
CREATE INDEX "moves_proposal_idx" ON "moves" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reserve_links_main_idx" ON "reserve_links" USING btree ("main_safe_id","chain_id");--> statement-breakpoint
CREATE INDEX "reserve_policy_changes_safe_idx" ON "reserve_policy_changes" USING btree ("safe_id","chain_id","status");--> statement-breakpoint
CREATE INDEX "reserve_runs_loan_idx" ON "reserve_runs" USING btree ("safe_id","loan_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "standing_rules_loan_idx" ON "standing_rules" USING btree ("safe_id","loan_id");