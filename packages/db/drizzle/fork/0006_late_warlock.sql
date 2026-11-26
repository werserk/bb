CREATE TABLE `thread_send_intakes` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`client_submission_id` text,
	`intake_order` integer NOT NULL,
	`original_envelope` text,
	`original_fingerprint` text NOT NULL,
	`current_envelope` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`claim_token` text,
	`claim_epoch` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` integer,
	`sealed_at` integer,
	`resend_count` integer DEFAULT 0 NOT NULL,
	`admission_receipt` text,
	`native_receipt` text,
	`native_handoff` text,
	`clear_operation_id` text,
	`compact_request_id` text,
	`compact_checkpoint` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "thread_send_intakes_state_check" CHECK("thread_send_intakes"."state" IN ('staging','pending','preparing','transferred','failed','cancelled','rejected')),
	CONSTRAINT "thread_send_intakes_payload_check" CHECK("thread_send_intakes"."state" IN ('transferred','cancelled','rejected') OR ("thread_send_intakes"."original_envelope" IS NOT NULL AND "thread_send_intakes"."current_envelope" IS NOT NULL)),
	CONSTRAINT "thread_send_intakes_claim_check" CHECK(("thread_send_intakes"."state" = 'preparing' AND "thread_send_intakes"."claim_token" IS NOT NULL AND "thread_send_intakes"."lease_expires_at" IS NOT NULL) OR ("thread_send_intakes"."state" <> 'preparing' AND "thread_send_intakes"."claim_token" IS NULL AND "thread_send_intakes"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_send_intakes_submission_idx` ON `thread_send_intakes` (`thread_id`,`client_submission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_send_intakes_order_idx` ON `thread_send_intakes` (`thread_id`,`intake_order`);--> statement-breakpoint
CREATE INDEX `thread_send_intakes_recovery_idx` ON `thread_send_intakes` (`state`,`lease_expires_at`);