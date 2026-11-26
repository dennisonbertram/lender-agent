CREATE TABLE "loan_levels" (
	"safe_id" integer NOT NULL,
	"loan_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"warn" double precision NOT NULL,
	"act" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_levels_safe_id_loan_id_pk" PRIMARY KEY("safe_id","loan_id")
);
--> statement-breakpoint
CREATE TABLE "monitor_status" (
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"last_check_at" timestamp with time zone NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"source" text NOT NULL,
	"loan_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "monitor_status_safe_id_chain_id_pk" PRIMARY KEY("safe_id","chain_id")
);
--> statement-breakpoint
ALTER TABLE "loan_levels" ADD CONSTRAINT "loan_levels_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_status" ADD CONSTRAINT "monitor_status_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;