-- Idempotent migration: widen external_links.system & sync_conflicts.source_system for Google Workspace dual-track sync
ALTER TABLE external_links DROP CONSTRAINT IF EXISTS external_links_system_check;
ALTER TABLE external_links
  ADD CONSTRAINT external_links_system_check
  CHECK (system IN ('icloud_contact', 'kjgx_app', 'legacy_macserver', 'google_contact', 'google_calendar_event', 'google_task'));

ALTER TABLE sync_conflicts DROP CONSTRAINT IF EXISTS sync_conflicts_source_system_check;
ALTER TABLE sync_conflicts
  ADD CONSTRAINT sync_conflicts_source_system_check
  CHECK (source_system IN ('icloud_contact', 'icloud_reminder', 'kjgx_app', 'google_contact', 'google_calendar', 'google_task'));
