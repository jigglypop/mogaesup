-- Whether the island wears a look when its bake finishes. Saving a look turns it on; picking a 미니미 or taking the look off
-- while it bakes turns it off, so a finished bake does not put the member back into a look they left.
ALTER TABLE user_looks ADD COLUMN IF NOT EXISTS wear_on_ready boolean NOT NULL DEFAULT true;
