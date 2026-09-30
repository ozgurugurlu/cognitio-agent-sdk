CREATE TABLE `session_checkpoint` (
	`session_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`message_id` text,
	`snapshot` text NOT NULL,
	`label` text,
	`source` text NOT NULL,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `session_checkpoint_pk` PRIMARY KEY(`session_id`, `checkpoint_id`),
	CONSTRAINT `fk_session_checkpoint_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `session` ADD `tags` text;--> statement-breakpoint
CREATE INDEX `session_checkpoint_session_time_idx` ON `session_checkpoint` (`session_id`,`time_created`,`checkpoint_id`);--> statement-breakpoint
CREATE INDEX `session_checkpoint_session_message_idx` ON `session_checkpoint` (`session_id`,`message_id`);