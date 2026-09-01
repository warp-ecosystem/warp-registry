import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Regular expression for validating user namespaces.
 * Namespaces must start with a lowercase alphanumeric character and can contain hyphens.
 * Kept here as the single source of truth so migrations classify GitHub usernames
 * the same way the signup endpoint does.
 */
export const NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * SQL schema definition for the database.
 * Creates tables for users, auth tokens, and versions with their constraints.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  namespace TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('admin', 'normal')) DEFAULT 'normal',
  has_published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
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
 * Migrates the database schema from v1 (owners) to v2 (users).
 * Only runs if the old owners table exists and the new users table does not.
 * Wraps the migration in a transaction for safety.
 *
 * Recovered-account note: v1 owners authenticated via GitHub OAuth, so they have
 * no password. The migration copies them with an empty password_hash. A migrated
 * account cannot log in with a password and instead requires a one-time recovery:
 *
 *   1. An admin sets a password via the CLI, or the account owner uses
 *      `PATCH /v2/users/:namespace` (requires an admin-issued token) to set one.
 *
 * Until a password is set the account cannot authenticate through the normal login flow.
 *
 * @param {import('better-sqlite3').Database} db - The database instance.
 */
function migrateSchema(db) {
  const hasUsers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    )
    .get();
  if (hasUsers) return;

  const hasOwners = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owners'",
    )
    .get();

  if (!hasOwners) return;

  db.exec("BEGIN");
  try {
    db.exec(
      `CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        namespace TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN ('admin', 'normal')) DEFAULT 'normal',
        has_published INTEGER NOT NULL DEFAULT 0
      )`,
    );

    const owners = db
      .prepare(
        "SELECT id, github_username, has_published FROM owners ORDER BY id",
      )
      .all();
    const usedNamespaces = new Set();
    const insertUser = db.prepare(
      "INSERT INTO users (id, namespace, password_hash, has_published) VALUES (?, ?, '', ?)",
    );
    for (const owner of owners) {
      let namespace = String(owner.github_username || "")
        .trim()
        .toLowerCase();
      if (!NAMESPACE_RE.test(namespace)) {
        namespace = `user${owner.id}`;
      }
      let candidate = namespace;
      let suffix = 0;
      while (usedNamespaces.has(candidate)) {
        suffix += 1;
        candidate = `${namespace}${suffix}`;
      }
      usedNamespaces.add(candidate);
      insertUser.run(owner.id, candidate, owner.has_published);
    }

    db.exec(
      `CREATE TABLE IF NOT EXISTS auth_tokens (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT
      )`,
    );

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

    db.exec(`DROP TABLE owners`);

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
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  db.exec(SCHEMA);
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
 * @param {string} owner - The package owner's namespace.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @returns {string} The full path to the blob file.
 */
export function blobPath(dataDir, owner, packageId, version) {
  return path.join(blobsDir(dataDir), owner, packageId, `${version}.js`);
}
