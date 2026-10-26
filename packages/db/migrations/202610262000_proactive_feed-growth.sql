-- The weekly "What I learned" Feed post (docs/agent/teaching-loop-2026.md §5.4, #681 T3): its
-- review items (`FeedPost.growth`, protocol GrowthCard). Owner: @psyche/proactive; written by the
-- teaching loop's weekly job.
ALTER TABLE feed_posts ADD COLUMN growth TEXT CHECK (growth IS NULL OR json_valid(growth));
