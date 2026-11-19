-- Sharing a 사주 (birth, chart, reading) needs the member's own consent. The island can stay
-- open; the chart stays with the owner until they agree.
ALTER TABLE users ADD COLUMN IF NOT EXISTS saju_share_consent_at timestamptz;
