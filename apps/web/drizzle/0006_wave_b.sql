CREATE TABLE "alert_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "alert_deliveries_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "alert_state" (
	"safe_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"crossed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_state_safe_id_loan_id_pk" PRIMARY KEY("safe_id","loan_id")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"hf" double precision NOT NULL,
	"warn" double precision NOT NULL,
	"act" double precision NOT NULL,
	"price" double precision,
	"cause" text,
	"snap" jsonb,
	"add_coll" double precision,
	"repay" double precision,
	"resolved_at" timestamp with time zone,
	"chat_posted_at" timestamp with time zone,
	"email_planned_at" timestamp with time zone,
	"event_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "email_prefs" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_prefs_unsubscribe_token_unique" UNIQUE("unsubscribe_token")
);
--> statement-breakpoint
CREATE TABLE "fix_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"option" text NOT NULL,
	"spec" jsonb NOT NULL,
	"title" text NOT NULL,
	"steps" jsonb NOT NULL,
	"health_before" double precision,
	"health_after" double precision,
	"test_run_line" text NOT NULL,
	"can_send" boolean NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"proposal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshots" ADD COLUMN "rate" text;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_prefs" ADD CONSTRAINT "email_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fix_drafts" ADD CONSTRAINT "fix_drafts_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_loan_idx" ON "alerts" USING btree ("safe_id","loan_id","id");--> statement-breakpoint
CREATE INDEX "fix_drafts_loan_idx" ON "fix_drafts" USING btree ("safe_id","loan_id","state");