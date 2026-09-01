#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";
import { success, error } from "../src/logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DEFAULT_DATA_DIR = path.join(root, "data");

const [, , username, packageId, version] = process.argv;

if (!username || !packageId || !version) {
  error("Usage: node scripts/approve.js <namespace> <package_id> <version>");
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
const db = openDatabase(dataDir);

const owner = db
  .prepare("SELECT id FROM users WHERE namespace = ?")
  .get(username);

if (!owner) {
  error(`User not found: ${username}`);
  process.exit(1);
}

const approve = db.transaction(() => {
  const result = db
    .prepare(
      `UPDATE versions SET status = 'published'
         WHERE owner_id = ? AND package_id = ? AND version = ?
           AND status = 'pending'`,
    )
    .run(owner.id, packageId, version);

  if (result.changes === 0) return false;

  db.prepare("UPDATE users SET has_published = 1 WHERE id = ?").run(owner.id);

  db.prepare(
    `DELETE FROM versions
       WHERE owner_id = ?
         AND status IN ('staging', 'pending')`,
  ).run(owner.id);
  return true;
}).immediate;

if (!approve()) {
  error(`No version found for ${username}/${packageId}@${version}`);
  process.exit(1);
}

success(
  `Approved ${username}/${packageId}@${version} (owner now has_published=1)`,
);
