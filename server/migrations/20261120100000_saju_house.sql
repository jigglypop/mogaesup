-- The house an owner chose for their 사주 home in place of the one their chart gives: its kind, its roof and its trim
-- ({style, roof, accent}); none for the chart's own.
ALTER TABLE saju_decor ADD COLUMN IF NOT EXISTS house jsonb;
