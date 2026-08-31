import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQL schema definition for the database.
 * Creates tables for owners and versions with their constraints.
 */
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

/**
 * Migrates the database schema to add the final_status column if needed.
 * Wraps the migration in a transaction for safety.
 * @param {import('better-sqlite3').Database} db - The database instance.
 */
function migrateSchema(db) {
  const versions = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'versions'",
    )
    .get();
  if (versions && /final_status/.test(versions.sql)) return;

  db.exec("BEGIN");
  try {
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
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Opens or creates a SQLite database in the specified data directory.
 * Applies the schema and runs any necessary migrations.
 * @param {string} dataDir - The directory where the database should be stored.
 * @returns {import('better-sqlite3').Database} The opened database instance.
 */
export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "registry.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  migrateSchema(db);
  db.exec(
    `DELETE FROM versions
     WHERE status IN ('staging', 'pending')
       AND id NOT IN (
         SELECT MIN(id) FROM versions
         WHERE status IN ('staging', 'pending')
         GROUP BY owner_id
       )`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS versions_one_pending_per_owner
     ON versions (owner_id)
     WHERE status IN ('staging', 'pending')`,
  );
  return db;
}

/**
 * Returns the path to the blobs directory within the data directory.
 * @param {string} dataDir - The data directory path.
 * @returns {string} The path to the blobs directory.
 */
export function blobsDir(dataDir) {
  return path.join(dataDir, "blobs");
}

/**
 * Constructs the file system path for a specific package version blob.
 * @param {string} dataDir - The data directory path.
 * @param {string} owner - The package owner's username.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @returns {string} The full path to the blob file.
 */
export function blobPath(dataDir, owner, packageId, version) {
  return path.join(blobsDir(dataDir), owner, packageId, `${version}.js`);
}
