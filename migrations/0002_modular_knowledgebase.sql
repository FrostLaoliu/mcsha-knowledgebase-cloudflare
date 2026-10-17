PRAGMA foreign_keys = ON;

-- Modular knowledge base foundation.
-- Existing characters, playbooks, users and their version tables remain untouched.
-- The two legacy modules continue reading from their original tables until the API
-- migration is implemented in a later step.

CREATE TABLE IF NOT EXISTS modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'boxes',
  source_type TEXT NOT NULL DEFAULT 'custom'
    CHECK (source_type IN ('characters', 'playbooks', 'custom')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS module_fields (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text', 'textarea', 'number', 'list', 'traits')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  options_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (module_id, field_key)
);

CREATE TABLE IF NOT EXISTS module_categories (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (module_id, name)
);

CREATE TABLE IF NOT EXISTS module_entries (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '未分类',
  content_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_module_entries_module_updated
  ON module_entries(module_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_module_entries_module_category
  ON module_entries(module_id, category);

CREATE TABLE IF NOT EXISTS module_entry_versions (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES module_entries(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  editor_id TEXT NOT NULL REFERENCES users(id),
  edit_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entry_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_module_entry_versions_entry
  ON module_entry_versions(entry_id, version_number DESC);

-- Seed the two existing content areas as modules without moving or rewriting any
-- legacy records. This keeps current data and historical snapshots intact.
INSERT OR IGNORE INTO modules
  (id, name, slug, description, icon, source_type, sort_order)
VALUES
  ('module-characters', '角色资料', 'characters', '角色属性、背景设定与技能词条。', 'gamepad-2', 'characters', 10),
  ('module-playbooks', '玩法流程', 'playbooks', '玩法摘要、流程步骤与开发备注。', 'book-open', 'playbooks', 20);

-- Field definitions for the existing module editors; these describe the current
-- legacy data shapes and will be consumed by the modular UI/API in a later step.
INSERT OR IGNORE INTO module_fields
  (id, module_id, field_key, label, field_type, required, sort_order)
VALUES
  ('field-character-name', 'module-characters', 'name', '角色名称', 'text', 1, 10),
  ('field-character-health', 'module-characters', 'health', '角色血量', 'number', 1, 20),
  ('field-character-description', 'module-characters', 'description', '角色介绍', 'textarea', 0, 30),
  ('field-character-traits', 'module-characters', 'traits', '技能词条', 'traits', 0, 40),
  ('field-playbook-title', 'module-playbooks', 'title', '玩法名称', 'text', 1, 10),
  ('field-playbook-summary', 'module-playbooks', 'summary', '玩法摘要', 'textarea', 0, 20),
  ('field-playbook-steps', 'module-playbooks', 'steps', '流程步骤', 'list', 0, 30),
  ('field-playbook-notes', 'module-playbooks', 'notes', '开发备注', 'textarea', 0, 40);

-- Seed category options from existing records so the first migration exposes the
-- categories users already use, while retaining the original source records.
INSERT OR IGNORE INTO module_categories (id, module_id, name)
SELECT lower(hex(randomblob(16))), 'module-characters', category
FROM characters
WHERE trim(category) <> ''
GROUP BY category;

INSERT OR IGNORE INTO module_categories (id, module_id, name)
SELECT lower(hex(randomblob(16))), 'module-playbooks', category
FROM playbooks
WHERE trim(category) <> ''
GROUP BY category;

INSERT OR IGNORE INTO module_categories (id, module_id, name)
VALUES
  ('category-characters-default', 'module-characters', '未分类'),
  ('category-playbooks-default', 'module-playbooks', '未分类');
