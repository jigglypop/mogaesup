-- version: 001 rollback
-- warning: this permanently deletes all data owned by the 3D asset API.
-- apply only after taking a backup.

BEGIN;

DROP TABLE IF EXISTS world_meshy_animation_slot_option;
DROP TABLE IF EXISTS world_meshy_animation_catalog;
DROP TABLE IF EXISTS world_placement;
DROP TABLE IF EXISTS world_asset;
DROP TABLE IF EXISTS world_generation_job;
DROP TABLE IF EXISTS agent_usage;
DROP TABLE IF EXISTS media_model_capability;
DROP TABLE IF EXISTS media_model_option;
DROP TABLE IF EXISTS media_model_catalog;
DROP TABLE IF EXISTS agent_media_asset;
DROP TABLE IF EXISTS agent_settings;

COMMIT;
