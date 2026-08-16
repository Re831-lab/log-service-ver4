CREATE TABLE "logs" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"timestamp" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"service" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");
--> statement-breakpoint
CREATE INDEX "idx_logs_timestamp_id" ON "logs" USING btree ("timestamp" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_logs_service_timestamp" ON "logs" USING btree ("service","timestamp" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_logs_level_timestamp" ON "logs" USING btree ("level","timestamp" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_logs_attr_user_id" ON "logs" USING btree ((attributes->>'user_id'));
--> statement-breakpoint
CREATE INDEX "idx_logs_attr_region" ON "logs" USING btree ((attributes->>'region'));
--> statement-breakpoint
CREATE TABLE logs_default PARTITION OF logs DEFAULT;