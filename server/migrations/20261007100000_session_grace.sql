-- A session started over (src/auth.rs `start_over`: a password change, signing out the other devices) is not ended at
-- once: it is marked replaced and kept a moment, so requests already on their way with its cookie, and the browser's
-- other tabs, still pass while the answer brings the new cookie. A replaced session cannot start over again.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_at timestamptz;

-- When the account's password last changed, which forgets its other devices (src/auth.rs). Signing out the other
-- devices no longer forgets them. Until the first change, a device cookie signed for the account but never recorded in
-- `login_devices` (one given before devices were recorded) still counts as known, while the account keeps fewer than
-- its devices' cap.
ALTER TABLE users ADD COLUMN IF NOT EXISTS devices_reset_at timestamptz;
