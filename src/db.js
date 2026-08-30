import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id INTEGER PRIMARY KEY,
  github_username TEXT UNIQUE NOT NULL,
  token_hash TEXT NOT NULL,
  has_published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'pending', 'published')),
  final_status TEXT NOT NULL CHECK (final_status IN ('pending', 'published')),
  meta_json TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, package_id, version)
);
`;

function migrateSchema(db) {
  const versions = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'versions'",
    )
    .get();
  if (versions && /final_status/.test(versions.sql)) return;

  db.exec("ALTER TABLE versions RENAME TO versions_old");
  db.exec(SCHEMA);
  db.exec(
    `INSERT INTO versions (id, owner_id, package_id, version, status, final_status, meta_json, blob_path, created_at)
     SELECT id, owner_id, package_id, version, status,
            CASE WHEN status = 'published' THEN 'published' ELSE 'pending' END,
            meta_json, blob_path, created_at
     FROM versions_old`,
  );
  db.exec("DROP TABLE versions_old");
}

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "registry.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrateSchema(db);
  return db;
}

export function blobsDir(dataDir) {
  return path.join(dataDir, "blobs");
}

export function blobPath(dataDir, owner, packageId, version) {
  return path.join(blobsDir(dataDir), owner, packageId, `${version}.js`);
}
