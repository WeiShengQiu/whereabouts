import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const dataDir = path.resolve(process.env.DATA_DIR ?? './data')
fs.mkdirSync(dataDir, { recursive: true })

/** 产物目录：文件名一律由 UUID 生成，禁止拼接用户输入 */
export const filesDir = path.join(dataDir, 'files')
fs.mkdirSync(filesDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'travel-planner.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  user_agent  TEXT NOT NULL DEFAULT '',
  ip          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS llm_configs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  protocol       TEXT NOT NULL,
  base_url       TEXT NOT NULL,
  api_key_cipher TEXT NOT NULL,
  default_model  TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_configs_user ON llm_configs(user_id);

CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id     TEXT,
  requirement    TEXT NOT NULL,
  config_id      TEXT NOT NULL,
  model          TEXT NOT NULL,
  options_json   TEXT,
  selected_index INTEGER,
  guide_json     TEXT,
  evidence_json  TEXT,
  geo_json       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id);

CREATE TABLE IF NOT EXISTS generated_files (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON generated_files(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  email            TEXT NOT NULL,
  ip               TEXT NOT NULL,
  failed_count     INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  PRIMARY KEY (email, ip)
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  poi_key      TEXT NOT NULL,
  poi_name     TEXT NOT NULL,
  source       TEXT NOT NULL,
  rating       REAL,
  rating_raw   TEXT,
  rating_scale REAL,
  review_count INTEGER,
  url          TEXT,
  snippet      TEXT,
  origin       TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_user_poi ON evidence_items(user_id, poi_key);

-- 小红书实采研究线索：用户在自己浏览器用扩展采集、主动导入的分类笔记线索，
-- 只携带标题/摘要/互动数/链接，无评分。与 evidence_items（评分证据）严格分离。
CREATE TABLE IF NOT EXISTS xhs_research (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  keyword       TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  likes         INTEGER,
  cover         TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  collected_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xhs_research_user ON xhs_research(user_id, category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_research_url ON xhs_research(user_id, url);
`)

// 旧库补列：CREATE TABLE IF NOT EXISTS 不会改已有表，逐列补齐
const planColumns = db.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>
for (const column of ['evidence_json', 'geo_json', 'research_json']) {
  if (!planColumns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE plans ADD COLUMN ${column} TEXT`)
  }
}

// 实采线索新增封面图（笔记缩略图）；旧库补列，缺省空字符串不影响历史数据
const researchColumns = db.prepare('PRAGMA table_info(xhs_research)').all() as Array<{ name: string }>
if (!researchColumns.some((item) => item.name === 'cover')) {
  db.exec("ALTER TABLE xhs_research ADD COLUMN cover TEXT NOT NULL DEFAULT ''")
}
