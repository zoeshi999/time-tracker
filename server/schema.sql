-- 时间记录
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  description TEXT NOT NULL,
  area TEXT,            -- 大类：工作 / 生活
  category TEXT,        -- 小类：交付 / 睡眠 ...
  project TEXT,         -- 项目标签，可空
  source TEXT,          -- timer / pomodoro / manual / ai
  session TEXT,         -- 同一次计时（暂停分成的几段）共用一个
  estimate_ms INTEGER NOT NULL DEFAULT 0,  -- 开始时填的预估
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entries_start ON entries(start_time);
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);

-- 设置、分类、正在进行的计时，都存成 JSON
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
