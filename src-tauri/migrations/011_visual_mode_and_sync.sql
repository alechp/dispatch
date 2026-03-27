-- Migration 011: Visual mode hotkeys + bidirectional Yapture sync

-- Add yapture_task_id for bidirectional sync tracking
ALTER TABLE notifications ADD COLUMN yapture_task_id TEXT;

-- Default bidirectional sync setting (on by default)
INSERT OR IGNORE INTO settings (key, value) VALUES ('yapture_bidirectional_sync', 'true');
