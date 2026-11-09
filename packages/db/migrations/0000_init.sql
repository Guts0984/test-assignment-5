CREATE TYPE "public"."attachment_status" AS ENUM('pending', 'ready');--> statement-breakpoint
CREATE TYPE "public"."email_kind" AS ENUM('invite', 'mention_digest');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"declared_type" text NOT NULL,
	"detected_type" text,
	"size_bytes" bigint NOT NULL,
	"status" "attachment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "attachments_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "attachments_size_limit" CHECK ("attachments"."size_bytes" between 1 and 10485760),
	CONSTRAINT "attachments_file_name_length" CHECK (char_length("attachments"."file_name") between 1 and 255),
	CONSTRAINT "attachments_ready_has_type" CHECK ("attachments"."status" <> 'ready' or ("attachments"."detected_type" is not null and "attachments"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_columns_position_unique" UNIQUE("board_id","position"),
	CONSTRAINT "board_columns_id_board_unique" UNIQUE("id","board_id"),
	CONSTRAINT "board_columns_name_length" CHECK (char_length("board_columns"."name") between 1 and 100),
	CONSTRAINT "board_columns_position_format" CHECK ("board_columns"."position" ~ '^[0-9A-Za-z]+$')
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boards_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "boards_name_length" CHECK (char_length("boards"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')) STORED,
	CONSTRAINT "cards_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "cards_title_length" CHECK (char_length("cards"."title") between 1 and 200),
	CONSTRAINT "cards_description_length" CHECK (char_length("cards"."description") <= 20000),
	CONSTRAINT "cards_position_format" CHECK ("cards"."position" ~ '^[0-9A-Za-z]+$'),
	CONSTRAINT "cards_version_positive" CHECK ("cards"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "comment_mentions" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_mentions_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED,
	CONSTRAINT "comments_body_length" CHECK (char_length("comments"."body") between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "email_kind" NOT NULL,
	"user_id" uuid,
	"to_email" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_handle_format" CHECK ("users"."handle" ~ '^[a-z0-9_.-]{3,32}$'),
	CONSTRAINT "users_name_length" CHECK (char_length("users"."name") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "workspace_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invites_email_lowercase" CHECK ("workspace_invites"."email" = lower("workspace_invites"."email")),
	CONSTRAINT "workspace_invites_role_not_owner" CHECK ("workspace_invites"."role" <> 'owner')
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK (char_length("workspaces"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_card_workspace_fk" FOREIGN KEY ("card_id","workspace_id") REFERENCES "public"."cards"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_workspace_fk" FOREIGN KEY ("board_id","workspace_id") REFERENCES "public"."boards"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_column_board_fk" FOREIGN KEY ("column_id","board_id") REFERENCES "public"."board_columns"("id","board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_card_workspace_fk" FOREIGN KEY ("card_id","workspace_id") REFERENCES "public"."cards"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_board_idx" ON "activity_log" USING btree ("board_id","id");--> statement-breakpoint
CREATE INDEX "attachments_card_idx" ON "attachments" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "attachments_pending_idx" ON "attachments" USING btree ("created_at") WHERE "attachments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "boards_workspace_idx" ON "boards" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cards_column_order_idx" ON "cards" USING btree ("column_id","position","id") WHERE "cards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "cards_board_idx" ON "cards" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "cards_deleted_idx" ON "cards" USING btree ("deleted_at") WHERE "cards"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "cards_search_idx" ON "cards" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "comment_mentions_unclaimed_idx" ON "comment_mentions" USING btree ("user_id","created_at") WHERE "comment_mentions"."delivery_id" is null;--> statement-breakpoint
CREATE INDEX "comments_card_idx" ON "comments" USING btree ("card_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comments_search_idx" ON "comments" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "email_deliveries_user_kind_idx" ON "email_deliveries" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_pending_idx" ON "email_deliveries" USING btree ("created_at") WHERE "email_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invites_open_unique" ON "workspace_invites" USING btree ("workspace_id","email") WHERE "workspace_invites"."accepted_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");