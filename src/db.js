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
  status TEXT NOT NULL CHECK (status IN ('pending', 'published')),
  meta_json TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, package_id, version)
);
`;

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "registry.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function blobsDir(dataDir) {
  return path.join(dataDir, "blobs");
}

export function blobPath(dataDir, owner, packageId, version) {
  return path.join(blobsDir(dataDir), owner, packageId, `${version}.js`);
}
