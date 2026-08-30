#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DEFAULT_DATA_DIR = path.join(root, "data");

const [, , username, packageId, version] = process.argv;

if (!username || !packageId || !version) {
  console.error(
    "Usage: node scripts/approve.js <github_username> <package_id> <version>",
  );
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || DEFAULT_DATA_DIR);
const db = openDatabase(dataDir);

const owner = db
  .prepare("SELECT id FROM owners WHERE github_username = ?")
  .get(username);

if (!owner) {
  console.error(`Owner not found: ${username}`);
  process.exit(1);
}

const result = db
  .prepare(
    `UPDATE versions SET status = 'published'
     WHERE owner_id = ? AND package_id = ? AND version = ?`,
  )
  .run(owner.id, packageId, version);

if (result.changes === 0) {
  console.error(`No version found for ${username}/${packageId}@${version}`);
  process.exit(1);
}

db.prepare("UPDATE owners SET has_published = 1 WHERE id = ?").run(owner.id);

console.log(
  `Approved ${username}/${packageId}@${version} (owner now has_published=1)`,
);
