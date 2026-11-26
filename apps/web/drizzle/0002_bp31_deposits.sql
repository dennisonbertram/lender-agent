CREATE TABLE "deposit_balances" (
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"asset" text NOT NULL,
	"raw" text NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_balances_safe_id_chain_id_asset_pk" PRIMARY KEY("safe_id","chain_id","asset")
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" serial PRIMARY KEY NOT NULL,
	"safe_id" integer NOT NULL,
	"chain_id" integer NOT NULL,
	"asset" text NOT NULL,
	"raw" text NOT NULL,
	"amount" text NOT NULL,
	"value_usd" text NOT NULL,
	"block_number" bigint NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deposit_balances" ADD CONSTRAINT "deposit_balances_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_safe_id_safes_id_fk" FOREIGN KEY ("safe_id") REFERENCES "public"."safes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deposits_safe_idx" ON "deposits" USING btree ("safe_id","detected_at");