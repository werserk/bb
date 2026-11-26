CREATE TABLE `placement_binding` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`owner_plugin_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`agent_host_id` text NOT NULL,
	`generation` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_revision` integer NOT NULL,
	`workspace_digest` text NOT NULL,
	`bound_from_operation_id` text NOT NULL,
	`source_provider_thread_id` text,
	`source_checkpoint` text,
	`runtime_root_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bound_from_operation_id`) REFERENCES `placement_operation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`workspace_revision`,`workspace_digest`) REFERENCES `placement_workspace`(`workspace_binding_id`,`revision`,`workspace_digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_binding_bound_from_operation_id_unique` ON `placement_binding` (`bound_from_operation_id`);
--> statement-breakpoint
CREATE TABLE `placement_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`accepted_seq` integer DEFAULT 0 NOT NULL,
	`allocation_seq` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "placement_counter_singleton" CHECK("placement_counter"."id" = 1 AND "placement_counter"."accepted_seq" >= 0 AND "placement_counter"."allocation_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE `placement_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_scope` text NOT NULL,
	`submission_key` text NOT NULL,
	`accepted_seq` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`owner_plugin_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`worker_id` text,
	`kind` text NOT NULL,
	`requested_selection` text,
	`canonical_request` text NOT NULL,
	`payload_digest` text NOT NULL,
	`prepared_request` text,
	`prepared_execution` text,
	`attachment_receipts` text,
	`reserved_thread_id` text,
	`resolved_workspace_id` text,
	`resolved_workspace_revision` integer,
	`resolved_workspace_digest` text,
	`phase` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`reason` text,
	`failed_stage` text,
	`binding` text,
	`thread_id` text,
	`reservation_id` text,
	`fence` integer,
	`queued_message_id` text,
	`client_turn_request_id` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`failed_operation_id` text,
	`source_operation_id` text,
	`consent_id` text,
	`retry_derivation` text,
	`retry_schedule_state` text,
	`send_at` integer,
	`scheduler_revision` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`resolved_workspace_id`,`resolved_workspace_revision`,`resolved_workspace_digest`) REFERENCES `placement_workspace`(`workspace_binding_id`,`revision`,`workspace_digest`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_operation_version" CHECK("placement_operation"."schema_version" = 1 AND "placement_operation"."revision" > 0 AND "placement_operation"."accepted_seq" > 0),
	CONSTRAINT "placement_operation_kind" CHECK("placement_operation"."kind" IN ('independent','continuation','fork','retry')),
	CONSTRAINT "placement_operation_phase" CHECK("placement_operation"."phase" IN ('accepted','materializing','pending','reserved','creating','queued','admitted','starting','active','completed','failed','cancel_requested','cancelled','unknown','refused')),
	CONSTRAINT "placement_operation_retry" CHECK(("placement_operation"."kind" = 'retry' AND "placement_operation"."consent_id" IS NOT NULL AND "placement_operation"."failed_operation_id" IS NOT NULL AND "placement_operation"."retry_schedule_state" IN ('awaiting_scheduler','queued') AND "placement_operation"."scheduler_revision" >= 0) OR ("placement_operation"."kind" != 'retry' AND "placement_operation"."retry_schedule_state" IS NULL AND "placement_operation"."scheduler_revision" IS NULL)),
	CONSTRAINT "placement_operation_reserved_thread" CHECK("placement_operation"."reserved_thread_id" IS NULL OR "placement_operation"."kind" IN ('independent','fork')),
	CONSTRAINT "placement_operation_workspace" CHECK(("placement_operation"."resolved_workspace_id" IS NULL AND "placement_operation"."resolved_workspace_revision" IS NULL AND "placement_operation"."resolved_workspace_digest" IS NULL) OR ("placement_operation"."resolved_workspace_id" IS NOT NULL AND "placement_operation"."resolved_workspace_revision" IS NOT NULL AND "placement_operation"."resolved_workspace_digest" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_accepted_seq_unique` ON `placement_operation` (`accepted_seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_reserved_thread_id_unique` ON `placement_operation` (`reserved_thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_queued_message_id_unique` ON `placement_operation` (`queued_message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_client_turn_request_id_unique` ON `placement_operation` (`client_turn_request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_submission` ON `placement_operation` (`principal_scope`,`submission_key`);
--> statement-breakpoint
CREATE INDEX `placement_operation_pending` ON `placement_operation` (`owner_plugin_id`,`provider_id`,`phase`,`accepted_seq`,`id`);
--> statement-breakpoint
CREATE INDEX `placement_operation_worker_pending` ON `placement_operation` (`worker_id`,`phase`,`accepted_seq`,`id`);
--> statement-breakpoint
CREATE TABLE `placement_owner` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`owner_plugin_id` text NOT NULL,
	`mode` text DEFAULT 'disabled' NOT NULL,
	`revision` integer NOT NULL,
	`available` integer DEFAULT false NOT NULL,
	CONSTRAINT "placement_owner_mode" CHECK("placement_owner"."mode" IN ('disabled','managed')),
	CONSTRAINT "placement_owner_revision" CHECK("placement_owner"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `placement_retry_consent` (
	`consent_id` text PRIMARY KEY NOT NULL,
	`principal_scope` text NOT NULL,
	`submission_key` text NOT NULL,
	`failed_operation_id` text NOT NULL,
	`binding_digest` text NOT NULL,
	`failed_payload_digest` text NOT NULL,
	`allowed_attempts` integer DEFAULT 1 NOT NULL,
	`consumed_by_operation_id` text,
	`revoked_at` integer,
	`permission_provenance` text NOT NULL,
	FOREIGN KEY (`failed_operation_id`) REFERENCES `placement_operation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`consumed_by_operation_id`) REFERENCES `placement_operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_consent_budget" CHECK("placement_retry_consent"."allowed_attempts" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_retry_consent_consumed_by_operation_id_unique` ON `placement_retry_consent` (`consumed_by_operation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_consent_submission` ON `placement_retry_consent` (`principal_scope`,`submission_key`);
--> statement-breakpoint
CREATE TABLE `placement_worker` (
	`owner_plugin_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`agent_host_id` text NOT NULL,
	`generation` text NOT NULL,
	`provider_version` text NOT NULL,
	`observation_revision` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`route_evidence` text NOT NULL,
	`observation` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`slot_state` text NOT NULL,
	`owner_operation_id` text,
	`thread_id` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`last_assigned_seq` integer,
	`reclaim_operation_id` text,
	`reclaim_source_fence` integer,
	`native_custody` text,
	PRIMARY KEY(`owner_plugin_id`, `worker_id`),
	CONSTRAINT "placement_worker_slot" CHECK("placement_worker"."slot_state" IN ('free','reserved','resident','active','reclaiming','maintenance','unknown')),
	CONSTRAINT "placement_worker_owner" CHECK(("placement_worker"."slot_state" != 'free' OR ("placement_worker"."owner_operation_id" IS NULL AND "placement_worker"."thread_id" IS NULL AND "placement_worker"."reclaim_operation_id" IS NULL)) AND ("placement_worker"."slot_state" NOT IN ('reserved','resident','active','reclaiming') OR "placement_worker"."owner_operation_id" IS NOT NULL) AND ("placement_worker"."slot_state" != 'reclaiming' OR ("placement_worker"."reclaim_operation_id" IS NOT NULL AND "placement_worker"."reclaim_source_fence" IS NOT NULL))),
	CONSTRAINT "placement_worker_fence" CHECK("placement_worker"."fence" >= 0)
);
--> statement-breakpoint
CREATE INDEX `placement_worker_provider` ON `placement_worker` (`provider_id`,`available`);
--> statement-breakpoint
CREATE TABLE `placement_workspace` (
	`workspace_binding_id` text NOT NULL,
	`revision` integer NOT NULL,
	`workspace_digest` text NOT NULL,
	`canonical_descriptor` text NOT NULL,
	PRIMARY KEY(`workspace_binding_id`, `revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_workspace_ref` ON `placement_workspace` (`workspace_binding_id`,`revision`,`workspace_digest`);
--> statement-breakpoint
CREATE TRIGGER placement_workspace_immutable BEFORE UPDATE ON placement_workspace BEGIN SELECT RAISE(ABORT, 'immutable placement workspace'); END;
--> statement-breakpoint
CREATE TRIGGER placement_binding_immutable BEFORE UPDATE ON placement_binding BEGIN SELECT RAISE(ABORT, 'immutable placement binding'); END;
--> statement-breakpoint
CREATE TRIGGER placement_input_immutable BEFORE UPDATE OF canonical_request, payload_digest, principal_scope, submission_key, accepted_seq, kind, requested_selection ON placement_operation BEGIN SELECT RAISE(ABORT, 'immutable accepted placement'); END;
--> statement-breakpoint
ALTER TABLE `environments` ADD COLUMN `owner_placement_operation_id` text REFERENCES placement_operation(id) CONSTRAINT environments_single_owner_check CHECK(owner_thread_id IS NULL OR owner_placement_operation_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX environments_owner_placement_idx ON environments(owner_placement_operation_id) WHERE owner_placement_operation_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE queued_thread_messages ADD COLUMN placement_fence integer;
--> statement-breakpoint
ALTER TABLE queued_thread_messages ADD COLUMN placement_operation_id text REFERENCES placement_operation(id) CONSTRAINT queued_thread_messages_placement_check CHECK((placement_operation_id IS NULL) = (placement_fence IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX queued_thread_messages_placement_idx ON queued_thread_messages(placement_operation_id);
