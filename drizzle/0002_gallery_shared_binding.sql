CREATE TABLE `gallery_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`author` text NOT NULL,
	`purpose` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	`parent_id` text,
	`baseline_id` integer NOT NULL,
	`num_propellers` integer NOT NULL,
	`num_wings` integer NOT NULL,
	`reuses` integer DEFAULT 0 NOT NULL,
	`draft_json` text NOT NULL
);
