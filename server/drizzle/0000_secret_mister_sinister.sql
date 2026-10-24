CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"device_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"client_os" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"source_ip_hash" text,
	CONSTRAINT "device_authorizations_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_authorizations_user_code_hash_unique" UNIQUE("user_code_hash")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"fcm_token_enc" text NOT NULL,
	"fcm_token_hash" text NOT NULL,
	"device_secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"machine_id" text NOT NULL,
	"agent" text NOT NULL,
	"run_id" text NOT NULL,
	"host" text NOT NULL,
	"type" text NOT NULL,
	"blocking" boolean NOT NULL,
	"summary" text NOT NULL,
	"exit_code" integer,
	"duration_s" double precision,
	"email_allowed" boolean NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"routing" text NOT NULL,
	CONSTRAINT "events_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"user_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	"latest_event_id" uuid,
	"latest_summary" text,
	"trigger_event_id" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "groups_user_id_agent_window_start_pk" PRIMARY KEY("user_id","agent","window_start")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"active_runs" integer DEFAULT 0 NOT NULL,
	"silent_alerted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"user_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"machine_id" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"at" timestamp with time zone NOT NULL,
	"idle_seconds" double precision,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"user_id" uuid NOT NULL,
	"month" text NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_monthly_user_id_month_pk" PRIMARY KEY("user_id","month")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"firebase_uid" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"notify_on_phone" boolean DEFAULT false NOT NULL,
	"phone_alerts_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD CONSTRAINT "device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD CONSTRAINT "usage_monthly_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_event_channel_device" ON "deliveries" USING btree ("event_id","channel",coalesce("device_id", ''));--> statement-breakpoint
CREATE INDEX "deliveries_due" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "deliveries_event" ON "deliveries" USING btree ("user_id","event_id","channel");--> statement-breakpoint
CREATE INDEX "device_authorizations_expires" ON "device_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_token_hash" ON "devices" USING btree ("user_id","fcm_token_hash");--> statement-breakpoint
CREATE INDEX "devices_user_active" ON "devices" USING btree ("user_id","revoked_at","last_seen_at");--> statement-breakpoint
CREATE INDEX "events_dedupe" ON "events" USING btree ("user_id","run_id","type","summary","event_timestamp");--> statement-breakpoint
CREATE INDEX "events_machine_run" ON "events" USING btree ("machine_id","event_timestamp");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "machines_silence" ON "machines" USING btree ("last_heartbeat_at","silent_alerted_at");--> statement-breakpoint
CREATE INDEX "signals_reminder" ON "signals" USING btree ("user_id","run_id","kind","at");