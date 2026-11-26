CREATE TABLE "activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"actor_address" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"detail" text,
	"proposal_id" text,
	"event_key" text,
	CONSTRAINT "activity_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"seq" serial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"safe_id" integer NOT NULL,
	"role" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "operator_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_drafts" (
	"safe_id" integer PRIMARY KEY NOT NULL,
	"draft" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"tx" jsonb,
	"nonce" bigint,
	"safe_tx_hash" text,
	"idempotency_key" text NOT NULL,
	"title" text NOT NULL,
	"steps" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"stage" text NOT NULL,
	"confirmations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"threshold" integer,
	"executed_tx_hash" text,
	"test_run" jsonb,
	"stop_reason" text,
	"deleted_from_queue" boolean DEFAULT false NOT NULL,
	"replaced_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "safe_networks" (
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"deployed" boolean DEFAULT false NOT NULL,
	"agent_added" boolean DEFAULT false NOT NULL,
	"agent_changed_at" timestamp with time zone,
	"cached_owners" jsonb,
	"cached_threshold" integer,
	"owners_read_at" timestamp with time zone,
	CONSTRAINT "safe_networks_safe_id_chain_id_pk" PRIMARY KEY("safe_id","chain_id")
);
--> statement-breakpoint
CREATE TABLE "safes" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"name" text NOT NULL,
	"setup" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "safes_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"block_number" bigint NOT NULL,
	"health" text NOT NULL,
	"price" text,
	"debt" text NOT NULL,
	"collateral" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_safes" (
	"user_id" integer NOT NULL,
	"safe_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_safes_user_id_safe_id_pk" PRIMARY KEY("user_id","safe_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "worker_locks" (
	"job" text PRIMARY KEY NOT NULL,
	"locked_by" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worker_ticks" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_networks" ADD CONSTRAINT "safe_networks_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_safes" ADD CONSTRAINT "user_safes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_safes" ADD CONSTRAINT "user_safes_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_safe_idx" ON "activity" USING btree ("safe_id","at");--> statement-breakpoint
CREATE INDEX "messages_safe_idx" ON "messages" USING btree ("safe_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_hash_idx" ON "proposals" USING btree ("chain_id","safe_tx_hash");--> statement-breakpoint
CREATE INDEX "proposals_safe_idx" ON "proposals" USING btree ("safe_id","stage");--> statement-breakpoint
CREATE INDEX "snapshots_loan_idx" ON "snapshots" USING btree ("loan_id","at");--> statement-breakpoint
CREATE INDEX "worker_ticks_job_idx" ON "worker_ticks" USING btree ("job","started_at");