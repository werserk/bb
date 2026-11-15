CREATE TABLE `question_resolution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`revision` integer NOT NULL,
	`initial` integer NOT NULL,
	`principal` text NOT NULL,
	`operation_id` text NOT NULL,
	`request` text NOT NULL,
	`attribution` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_resolution_operation_idx` ON `question_resolution_events` (`principal`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_resolution_initial_idx` ON `question_resolution_events` (`target_kind`,`target_id`,`revision`) WHERE "question_resolution_events"."initial" = 1;--> statement-breakpoint
CREATE INDEX `question_resolution_target_idx` ON `question_resolution_events` (`target_kind`,`target_id`);