CREATE TABLE `placement_action_identity` (
	`op` text PRIMARY KEY NOT NULL,
	`native_protocol` text,
	`submission_uuid` text,
	`authority` text NOT NULL,
	FOREIGN KEY (`op`) REFERENCES `placement_operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_action_protocol" CHECK(("placement_action_identity"."native_protocol" IS NULL)=("placement_action_identity"."submission_uuid" IS NOT NULL)),
	CONSTRAINT "placement_submission_normalized" CHECK("placement_action_identity"."submission_uuid" IS NULL OR "placement_action_identity"."submission_uuid"=lower("placement_action_identity"."submission_uuid")),
	CONSTRAINT "placement_authority_json" CHECK(json_valid("placement_action_identity"."authority"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_action_identity_submission_uuid_unique` ON `placement_action_identity` (`submission_uuid`);--> statement-breakpoint
CREATE TABLE `placement_attempt` (
	`op` text NOT NULL,
	`step` integer NOT NULL,
	`attempt` integer NOT NULL,
	`queue_id` text,
	`queue_digest` text,
	`queue_ordinal` integer,
	`request` text,
	`ordinal` integer,
	PRIMARY KEY(`op`, `step`, `attempt`),
	FOREIGN KEY (`request`) REFERENCES `placement_effect`(`request`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`op`,`step`) REFERENCES `placement_step`(`op`,`step`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_attempt_numbers" CHECK("placement_attempt"."attempt">=0 AND ("placement_attempt"."queue_ordinal" IS NULL OR "placement_attempt"."queue_ordinal">=0) AND ("placement_attempt"."ordinal" IS NULL OR "placement_attempt"."ordinal">=0)),
	CONSTRAINT "placement_attempt_links" CHECK(("placement_attempt"."queue_id" IS NULL)=("placement_attempt"."queue_digest" IS NULL) AND ("placement_attempt"."queue_id" IS NULL)=("placement_attempt"."queue_ordinal" IS NULL) AND ("placement_attempt"."request" IS NULL)=("placement_attempt"."ordinal" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_attempt_request_member` ON `placement_attempt` (`request`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_attempt_queue_member` ON `placement_attempt` (`queue_id`,`queue_ordinal`);--> statement-breakpoint
CREATE INDEX `placement_attempt_queue` ON `placement_attempt` (`queue_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `placement_binding_bound_from_operation_id_unique` ON `placement_binding` (`bound_from_operation_id`);--> statement-breakpoint
CREATE TABLE `placement_counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`accepted_seq` integer DEFAULT 0 NOT NULL,
	`allocation_seq` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "placement_counter_singleton" CHECK("placement_counter"."id" = 1 AND "placement_counter"."accepted_seq" >= 0 AND "placement_counter"."allocation_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE `placement_effect` (
	`request` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`request_sequence` integer NOT NULL,
	`live_event_id` text,
	`rejection_event_id` text,
	`live_rejection_event_id` text,
	`rejection_reason` text,
	`thread` text NOT NULL,
	`root` text NOT NULL,
	`execution_owner_operation_id` text NOT NULL,
	`native_execution_id` text,
	`agent_session_id` text,
	`command_id` text,
	`binding` text NOT NULL,
	`fence` integer NOT NULL,
	`execution` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`live_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`live_rejection_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root`) REFERENCES `placement_effect`(`request`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`execution_owner_operation_id`) REFERENCES `placement_operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_effect_live_identity" CHECK("placement_effect"."live_event_id" IS NULL OR "placement_effect"."live_event_id"="placement_effect"."event_id"),
	CONSTRAINT "placement_effect_rejection" CHECK(("placement_effect"."rejection_event_id" IS NULL AND "placement_effect"."live_rejection_event_id" IS NULL AND "placement_effect"."rejection_reason" IS NULL) OR ("placement_effect"."state" IN ('refused','refused_unsent') AND "placement_effect"."rejection_event_id" IS NOT NULL AND ("placement_effect"."live_rejection_event_id" IS NULL OR "placement_effect"."live_rejection_event_id" IS "placement_effect"."rejection_event_id") AND ("placement_effect"."rejection_reason" IS NULL OR "placement_effect"."rejection_reason" IN ('managed_execution_unsupported','managed_admission_unavailable')))),
	CONSTRAINT "placement_effect_command_tuple" CHECK(("placement_effect"."command_id" IS NULL)=("placement_effect"."native_execution_id" IS NULL) AND ("placement_effect"."command_id" IS NULL)=("placement_effect"."agent_session_id" IS NULL) AND ("placement_effect"."command_id" IS NOT NULL OR "placement_effect"."state" IN ('prepared','refused_unsent','cancelled'))),
	CONSTRAINT "placement_effect_fence" CHECK("placement_effect"."fence">0),
	CONSTRAINT "placement_effect_state" CHECK("placement_effect"."state" IN ('prepared','possibly_sent','succeeded','failed_accepted','refused','refused_unsent','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_event_id_unique` ON `placement_effect` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_live_event_id_unique` ON `placement_effect` (`live_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_rejection_event_id_unique` ON `placement_effect` (`rejection_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_live_rejection_event_id_unique` ON `placement_effect` (`live_rejection_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_native_execution_id_unique` ON `placement_effect` (`native_execution_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_effect_command_id_unique` ON `placement_effect` (`command_id`);--> statement-breakpoint
CREATE INDEX `placement_active_effect_owner_fence` ON `placement_effect` (`execution_owner_operation_id`,`fence`) WHERE "placement_effect"."state" IN ('possibly_sent','prepared');--> statement-breakpoint
CREATE TABLE `placement_grant_key` (
	`principal` text NOT NULL,
	`transport_key` text NOT NULL,
	`consent` text NOT NULL,
	PRIMARY KEY(`principal`, `transport_key`),
	FOREIGN KEY (`consent`) REFERENCES `placement_retry_consent`(`consent_id`) ON UPDATE no action ON DELETE no action
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
	CONSTRAINT "placement_operation_retry" CHECK(("placement_operation"."kind" = 'retry' AND "placement_operation"."consent_id" IS NOT NULL AND "placement_operation"."failed_operation_id" IS NOT NULL AND "placement_operation"."retry_schedule_state" IS NOT NULL AND "placement_operation"."scheduler_revision" IS NOT NULL AND "placement_operation"."retry_schedule_state" IN ('awaiting_scheduler','queued') AND "placement_operation"."scheduler_revision" >= 0) OR ("placement_operation"."kind" != 'retry' AND "placement_operation"."retry_schedule_state" IS NULL AND "placement_operation"."scheduler_revision" IS NULL)),
	CONSTRAINT "placement_operation_reserved_thread" CHECK("placement_operation"."reserved_thread_id" IS NULL OR "placement_operation"."kind" IN ('independent','fork')),
	CONSTRAINT "placement_operation_workspace" CHECK(("placement_operation"."resolved_workspace_id" IS NULL AND "placement_operation"."resolved_workspace_revision" IS NULL AND "placement_operation"."resolved_workspace_digest" IS NULL) OR ("placement_operation"."resolved_workspace_id" IS NOT NULL AND "placement_operation"."resolved_workspace_revision" IS NOT NULL AND "placement_operation"."resolved_workspace_digest" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_accepted_seq_unique` ON `placement_operation` (`accepted_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_reserved_thread_id_unique` ON `placement_operation` (`reserved_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_queued_message_id_unique` ON `placement_operation` (`queued_message_id`);--> statement-breakpoint
CREATE INDEX `placement_operation_latest_request_idx` ON `placement_operation` (`client_turn_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_operation_submission` ON `placement_operation` (`principal_scope`,`submission_key`);--> statement-breakpoint
CREATE INDEX `placement_operation_pending` ON `placement_operation` (`owner_plugin_id`,`provider_id`,`phase`,`accepted_seq`,`id`);--> statement-breakpoint
CREATE INDEX `placement_operation_worker_pending` ON `placement_operation` (`worker_id`,`phase`,`accepted_seq`,`id`);--> statement-breakpoint
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
	`action_id` text NOT NULL,
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
CREATE UNIQUE INDEX `placement_retry_consent_consumed_by_operation_id_unique` ON `placement_retry_consent` (`consumed_by_operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_consent_action` ON `placement_retry_consent` (`principal_scope`,`action_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `placement_consent_submission` ON `placement_retry_consent` (`principal_scope`,`submission_key`);--> statement-breakpoint
CREATE TABLE `placement_retry_target` (
	`consent` text PRIMARY KEY NOT NULL,
	`failed_request` text NOT NULL,
	`root` text NOT NULL,
	`group_digest` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`consent`) REFERENCES `placement_retry_consent`(`consent_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`failed_request`) REFERENCES `placement_effect`(`request`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root`) REFERENCES `placement_effect`(`request`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_retry_state" CHECK("placement_retry_target"."state" IN ('held','scheduled','spent','revoked','expired','superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_one_retry` ON `placement_retry_target` (`failed_request`) WHERE "placement_retry_target"."state" IN ('held','scheduled','spent');--> statement-breakpoint
CREATE UNIQUE INDEX `placement_one_live_chain_retry` ON `placement_retry_target` (`root`) WHERE "placement_retry_target"."state" IN ('held','scheduled');--> statement-breakpoint
CREATE TABLE `placement_source_fact` (
	`source` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`bytes` text NOT NULL,
	`blocked_lock` text
);
--> statement-breakpoint
CREATE INDEX `placement_source_blocked_lock` ON `placement_source_fact` (`blocked_lock`) WHERE "placement_source_fact"."blocked_lock" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `placement_step` (
	`op` text NOT NULL,
	`step` integer NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`op`, `step`),
	FOREIGN KEY (`op`) REFERENCES `placement_action_identity`(`op`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "placement_step_number" CHECK("placement_step"."step">=0),
	CONSTRAINT "placement_step_kind" CHECK("placement_step"."kind" IN ('compact','input','retry','answer','clear'))
);
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
	`observation` text NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`slot_state` text NOT NULL,
	`owner_operation_id` text,
	`thread_id` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`last_assigned_seq` integer,
	`reclaim_operation_id` text,
	`reclaim_source_fence` integer,
	`reclaim_holder` text,
	`physical_lock` text,
	`fence_lock` text,
	`native_custody` text,
	PRIMARY KEY(`owner_plugin_id`, `worker_id`),
	CONSTRAINT "placement_worker_slot" CHECK("placement_worker"."slot_state" IN ('free','reserved','resident','active','reclaiming','maintenance','unknown')),
	CONSTRAINT "placement_worker_owner" CHECK(("placement_worker"."slot_state" != 'free' OR ("placement_worker"."owner_operation_id" IS NULL AND "placement_worker"."thread_id" IS NULL AND "placement_worker"."reclaim_operation_id" IS NULL)) AND ("placement_worker"."slot_state" NOT IN ('reserved','resident','active','reclaiming') OR "placement_worker"."owner_operation_id" IS NOT NULL) AND ("placement_worker"."slot_state" != 'reclaiming' OR ("placement_worker"."reclaim_operation_id" IS NOT NULL AND "placement_worker"."reclaim_source_fence" IS NOT NULL))),
	CONSTRAINT "placement_worker_lock_pin" CHECK(("placement_worker"."owner_operation_id" IS NULL AND "placement_worker"."physical_lock" IS NULL AND "placement_worker"."fence_lock" IS NULL) OR ("placement_worker"."owner_operation_id" IS NOT NULL AND "placement_worker"."physical_lock" IS NOT NULL AND json_type("placement_worker"."physical_lock",'$[0]') IS 'text' AND json_type("placement_worker"."fence_lock",'$.device') IS 'text' AND json_type("placement_worker"."fence_lock",'$.inode') IS 'text' AND NOT(json_extract("placement_worker"."fence_lock",'$.device') GLOB '0[0-9]*' AND json_extract("placement_worker"."fence_lock",'$.device') NOT GLOB '*[^0-9]*') AND NOT(json_extract("placement_worker"."fence_lock",'$.inode') GLOB '0[0-9]*' AND json_extract("placement_worker"."fence_lock",'$.inode') NOT GLOB '*[^0-9]*') AND "placement_worker"."physical_lock"=json_array(json_extract("placement_worker"."physical_lock",'$[0]'),json_extract("placement_worker"."fence_lock",'$.device'),json_extract("placement_worker"."fence_lock",'$.inode')))),
	CONSTRAINT "placement_worker_fence" CHECK("placement_worker"."fence" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_worker_physical_lock_unique` ON `placement_worker` (`physical_lock`);--> statement-breakpoint
CREATE INDEX `placement_worker_provider` ON `placement_worker` (`provider_id`,`available`);--> statement-breakpoint
CREATE TABLE `placement_workspace` (
	`workspace_binding_id` text NOT NULL,
	`revision` integer NOT NULL,
	`workspace_digest` text NOT NULL,
	`location_snapshot` text NOT NULL,
	`canonical_descriptor` text NOT NULL,
	PRIMARY KEY(`workspace_binding_id`, `revision`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `placement_workspace_ref` ON `placement_workspace` (`workspace_binding_id`,`revision`,`workspace_digest`);--> statement-breakpoint
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
ALTER TABLE queued_thread_messages ADD COLUMN placement_operation_id text REFERENCES placement_operation(id) CONSTRAINT queued_thread_messages_placement_check CHECK(placement_fence IS NULL OR (placement_operation_id IS NOT NULL AND placement_fence > 0));
--> statement-breakpoint
CREATE UNIQUE INDEX queued_thread_messages_placement_idx ON queued_thread_messages(placement_operation_id);
--> statement-breakpoint
CREATE TRIGGER placement_attempt_order BEFORE INSERT ON placement_attempt BEGIN
SELECT CASE WHEN NEW.request IS NOT NULL THEN RAISE(ABORT,'create unassigned attempt first') END;
SELECT CASE WHEN NEW.attempt <> COALESCE((SELECT max(attempt)+1 FROM placement_attempt
WHERE op=NEW.op AND step=NEW.step),0) THEN RAISE(ABORT,'attempt gap') END;
SELECT CASE WHEN NEW.attempt>0 AND NOT EXISTS(
SELECT 1 FROM placement_attempt a JOIN placement_effect e ON a.request=e.request
JOIN events rejection ON rejection.id=e.live_rejection_event_id AND rejection.id=e.rejection_event_id
WHERE a.op=NEW.op AND a.step=NEW.step AND a.attempt=NEW.attempt-1 AND e.state='refused'
AND e.live_event_id IS NOT NULL AND json_extract(rejection.data,'$.deferredToQueuedMessageId')=NEW.queue_id
) THEN RAISE(ABORT,'redelivery needs proven refusal') END;
END;
--> statement-breakpoint
CREATE TRIGGER placement_attempt_identity BEFORE UPDATE OF op,step,attempt,queue_id,queue_digest,queue_ordinal ON placement_attempt
BEGIN SELECT RAISE(ABORT,'immutable attempt'); END;
--> statement-breakpoint
CREATE TRIGGER placement_attempt_assigned BEFORE UPDATE OF request,ordinal ON placement_attempt
WHEN OLD.request IS NOT NULL BEGIN SELECT RAISE(ABORT,'attempt already assigned'); END;
--> statement-breakpoint
CREATE TRIGGER placement_attempt_admit BEFORE UPDATE OF request ON placement_attempt
WHEN NEW.request IS NOT NULL BEGIN
SELECT CASE WHEN EXISTS(SELECT 1 FROM placement_step s WHERE s.op=NEW.op AND s.step<NEW.step
AND NOT EXISTS(SELECT 1 FROM placement_attempt a JOIN placement_effect e ON e.request=a.request
WHERE (a.op,a.step)=(s.op,s.step) AND e.state='succeeded'))
THEN RAISE(ABORT,'prior step incomplete') END;
SELECT CASE WHEN EXISTS(SELECT 1 FROM placement_attempt a
JOIN placement_action_identity old ON old.op=a.op
JOIN placement_action_identity incoming ON incoming.op=NEW.op
WHERE a.request=NEW.request AND old.authority<>incoming.authority)
THEN RAISE(ABORT,'incompatible authority') END;
END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_transition BEFORE UPDATE OF state ON placement_effect
WHEN NOT ((OLD.state='prepared' AND NEW.state IN ('possibly_sent','refused_unsent','cancelled'))
OR (OLD.state='possibly_sent' AND NEW.state IN ('succeeded','refused','failed_accepted')))
BEGIN SELECT RAISE(ABORT,'invalid effect transition'); END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_identity BEFORE UPDATE OF request,event_id,request_sequence,thread,root,execution_owner_operation_id,binding,fence,execution
ON placement_effect BEGIN SELECT RAISE(ABORT,'immutable effect'); END;
--> statement-breakpoint
CREATE TRIGGER placement_action_immutable BEFORE UPDATE ON placement_action_identity
BEGIN SELECT RAISE(ABORT,'immutable action identity'); END;
--> statement-breakpoint
CREATE TRIGGER placement_step_immutable BEFORE UPDATE ON placement_step
BEGIN SELECT RAISE(ABORT,'immutable step'); END;
--> statement-breakpoint
CREATE TRIGGER placement_retry_target_identity BEFORE UPDATE OF consent,failed_request,root,group_digest ON placement_retry_target
BEGIN SELECT RAISE(ABORT,'immutable retry target'); END;
--> statement-breakpoint
CREATE TRIGGER placement_retry_transition BEFORE UPDATE OF state ON placement_retry_target
WHEN NOT ((OLD.state='held' AND NEW.state IN ('scheduled','revoked','expired','superseded')) OR
(OLD.state='scheduled' AND NEW.state IN ('spent','revoked','expired','superseded')))
BEGIN SELECT RAISE(ABORT,'closed retry entitlement'); END;
--> statement-breakpoint
CREATE TRIGGER placement_consent_action_immutable BEFORE UPDATE OF action_id,principal_scope,failed_operation_id,
binding_digest,failed_payload_digest,permission_provenance ON placement_retry_consent
BEGIN SELECT RAISE(ABORT,'immutable consent identity'); END;
--> statement-breakpoint
CREATE TRIGGER placement_consent_requires_action BEFORE INSERT ON placement_retry_consent
WHEN NEW.action_id IS NULL OR length(NEW.action_id)=0 BEGIN SELECT RAISE(ABORT,'missing grant action'); END;
--> statement-breakpoint
CREATE TRIGGER placement_step_order BEFORE INSERT ON placement_step
WHEN NEW.step <> COALESCE((SELECT max(step)+1 FROM placement_step WHERE op=NEW.op),0)
BEGIN SELECT RAISE(ABORT,'step gap'); END;
--> statement-breakpoint
CREATE TRIGGER placement_retry_envelope_immutable BEFORE UPDATE OF retry_derivation ON placement_operation
WHEN OLD.retry_derivation IS NOT NULL AND NEW.retry_derivation IS NOT OLD.retry_derivation
BEGIN SELECT RAISE(ABORT,'immutable retry envelope'); END;
--> statement-breakpoint
CREATE TRIGGER placement_command_immutable BEFORE UPDATE OF command_id,native_execution_id,agent_session_id ON placement_effect
WHEN OLD.command_id IS NOT NULL OR OLD.state!='prepared' OR NEW.command_id IS NULL OR NEW.native_execution_id IS NULL OR NEW.agent_session_id IS NULL
BEGIN SELECT RAISE(ABORT,'immutable placement command'); END;
--> statement-breakpoint
CREATE TRIGGER placement_prepared_request_immutable BEFORE UPDATE OF prepared_request ON placement_operation
WHEN OLD.prepared_request IS NOT NULL AND NEW.prepared_request IS NOT OLD.prepared_request
BEGIN SELECT RAISE(ABORT,'immutable prepared placement input'); END;

--> statement-breakpoint
CREATE TRIGGER placement_effect_anchor BEFORE INSERT ON placement_effect
WHEN NEW.rejection_event_id IS NOT NULL OR NEW.state <> 'prepared' OR NEW.live_event_id IS NOT NEW.event_id OR NOT EXISTS (SELECT 1 FROM events
 WHERE id=NEW.event_id AND thread_id=NEW.thread AND sequence=NEW.request_sequence AND type='client/turn/requested' AND json_extract(data,'$.requestId')=NEW.request)
BEGIN SELECT RAISE(ABORT,'missing native requested event'); END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_no_relink BEFORE UPDATE OF live_event_id ON placement_effect
WHEN NEW.live_event_id IS NOT NULL OR EXISTS (SELECT 1 FROM events WHERE id=OLD.live_event_id)
BEGIN SELECT RAISE(ABORT,'immutable native event link'); END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_detached AFTER UPDATE OF live_event_id ON placement_effect
WHEN NEW.live_event_id IS NULL AND OLD.state='prepared'
BEGIN UPDATE placement_effect SET state='cancelled' WHERE request=OLD.request; END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_require_rejection BEFORE UPDATE OF state ON placement_effect
WHEN (NEW.state='refused_unsent' OR (NEW.state='refused' AND NEW.rejection_event_id IS NOT NULL)) AND (OLD.live_event_id IS NULL OR NEW.live_rejection_event_id IS NULL
 OR NEW.live_rejection_event_id IS NOT NEW.rejection_event_id OR NOT EXISTS (
 SELECT 1 FROM events e WHERE e.id=NEW.rejection_event_id AND e.thread_id=OLD.thread
 AND e.sequence>OLD.request_sequence AND e.type='client/turn/rejected' AND e.scope_kind='thread'
 AND json_extract(e.data,'$.requestId')=OLD.request AND (NEW.state='refused' OR json_extract(e.data,'$.deferredToQueuedMessageId') IS NULL)
 AND NEW.rejection_reason IS (CASE WHEN NEW.state='refused_unsent' AND json_extract(e.data,'$.reason') IN ('managed_execution_unsupported','managed_admission_unavailable')
 THEN json_extract(e.data,'$.reason') END)))
BEGIN SELECT RAISE(ABORT,'missing native rejection evidence'); END;
--> statement-breakpoint
CREATE TRIGGER placement_effect_rejection_immutable BEFORE UPDATE OF rejection_event_id,rejection_reason,live_rejection_event_id ON placement_effect
WHEN NOT ((OLD.state='prepared' AND NEW.state='refused_unsent') OR (OLD.state='possibly_sent' AND NEW.state='refused')) AND NOT (
 OLD.rejection_event_id IS NEW.rejection_event_id AND OLD.rejection_reason IS NEW.rejection_reason
 AND OLD.live_rejection_event_id IS NOT NULL AND NEW.live_rejection_event_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM events WHERE id=OLD.live_rejection_event_id))
BEGIN SELECT RAISE(ABORT,'immutable native rejection evidence'); END;
--> statement-breakpoint
CREATE TRIGGER placement_worker_physical_pin BEFORE UPDATE OF physical_lock ON placement_worker
WHEN NEW.physical_lock IS NOT NULL AND (json_extract(NEW.physical_lock,'$[0]') IS NOT NEW.agent_host_id
 OR (OLD.physical_lock IS NOT NULL AND NEW.physical_lock IS NOT OLD.physical_lock))
BEGIN SELECT RAISE(ABORT,'physical lock changed during ownership'); END;

--> statement-breakpoint
CREATE TRIGGER placement_worker_initial_pin BEFORE INSERT ON placement_worker
WHEN NEW.physical_lock IS NOT NULL AND json_extract(NEW.physical_lock,'$[0]') IS NOT NEW.agent_host_id
BEGIN SELECT RAISE(ABORT,'wrong physical lock host'); END;

--> statement-breakpoint
CREATE TRIGGER placement_worker_physical_release BEFORE UPDATE OF physical_lock ON placement_worker
WHEN OLD.physical_lock IS NOT NULL AND NEW.physical_lock IS NULL AND (
 OLD.slot_state='reclaiming' AND OLD.reclaim_source_fence=OLD.fence AND NEW.slot_state='free'
 AND json_extract(NEW.native_custody,'$.status') IS 'free'
 AND json_extract(NEW.native_custody,'$.revision') > json_extract(OLD.native_custody,'$.revision')
 AND json_array(json_extract(NEW.native_custody,'$.agentHostId'),json_extract(NEW.native_custody,'$.lock.device'),json_extract(NEW.native_custody,'$.lock.inode'))=OLD.physical_lock) IS NOT TRUE
BEGIN SELECT RAISE(ABORT,'physical release requires verified reclaim'); END;
