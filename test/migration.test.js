import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDatabase } from "../src/db.js";

test("v1 owners schema is migrated to v2 users schema", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-registry-migr-"));
  try {
    const db = new Database(path.join(dir, "registry.db"));
    db.exec(`
      CREATE TABLE owners (
        id INTEGER PRIMARY KEY,
        github_username TEXT UNIQUE NOT NULL,
        token_hash TEXT NOT NULL,
        has_published INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE versions (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES owners(id),
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('staging','pending','published')),
        final_status TEXT NOT NULL CHECK (final_status IN ('pending','published')),
        meta_json TEXT NOT NULL,
        blob_path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (owner_id, package_id, version)
      );
      INSERT INTO owners (id, github_username, token_hash, has_published)
        VALUES (1, 'OldUser', 'hash', 1);
      INSERT INTO owners (id, github_username, token_hash, has_published)
        VALUES (2, 'Mixed Case Name!', 'hash', 0);
      INSERT INTO owners (id, github_username, token_hash, has_published)
        VALUES (3, 'olduser', 'hash', 1);
      INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
        VALUES (1, 'oldpkg', '1.0.0', 'published', 'published', '{}', '/tmp/x.js');
    `);
    db.close();

    const ndb = openDatabase(dir);
    try {
      const tables = ndb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name);
      assert.ok(!tables.includes("owners"), "owners table must be dropped");
      assert.ok(tables.includes("users"), "users table must exist");
      assert.ok(tables.includes("auth_tokens"), "auth_tokens table must exist");

      const user = ndb
        .prepare("SELECT * FROM users WHERE namespace = 'olduser'")
        .get();
      assert.ok(user, "migrated user must exist");
      assert.equal(user.has_published, 1);
      assert.equal(
        user.password_hash,
        "",
        "migrated users get empty password_hash and require recovery",
      );

      const normalized = ndb
        .prepare("SELECT * FROM users WHERE namespace = 'user2'")
        .get();
      assert.ok(
        normalized,
        "invalid GitHub usernames are normalized to a valid lowercase namespace",
      );

      const users = ndb.prepare("SELECT COUNT(*) AS c FROM users").get().c;
      assert.equal(users, 3, "all migrated rows are preserved");

      const collided = ndb.prepare("SELECT * FROM users WHERE id = 3").get();
      assert.ok(collided, "colliding owner row must be migrated");
      assert.equal(
        collided.namespace,
        "olduser1",
        "name collisions are de-duplicated with a numeric suffix visible to users",
      );

      const version = ndb
        .prepare("SELECT * FROM versions WHERE package_id = 'oldpkg'")
        .get();
      assert.equal(version.owner_id, user.id);
      assert.equal(version.status, "published");

      ndb
        .prepare(
          "INSERT INTO auth_tokens (user_id, token_hash) VALUES (?, 'sometokenhash')",
        )
        .run(user.id);
    } finally {
      ndb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
