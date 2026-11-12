ALTER TABLE `question_resolution_events` ADD `delivery_id` text;--> statement-breakpoint
ALTER TABLE `question_resolution_events` ADD `submitted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `question_resolution_delivery_idx` ON `question_resolution_events` (`delivery_id`);