CREATE TABLE `conversation_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`source_turn_id` text,
	`source_call_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`publication` text NOT NULL,
	`material_manifest` text NOT NULL,
	`response` text,
	`queued_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_questions_answer_custody" CHECK("conversation_questions"."status" != 'answered' OR ("conversation_questions"."response" IS NOT NULL AND "conversation_questions"."queued_message_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `conversation_questions_thread_created_idx` ON `conversation_questions` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `conversation_questions_thread_status_idx` ON `conversation_questions` (`thread_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_questions_source_idx` ON `conversation_questions` (`thread_id`,`source_turn_id`,`source_call_id`);