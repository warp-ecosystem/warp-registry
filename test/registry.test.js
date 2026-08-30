import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { openDatabase, blobPath } from "../src/db.js";
import {
  createApp,
  hashToken,
  reconcileStagedVersions,
} from "../src/routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturesDir = path.join(root, "fixtures");

/**
 * Starts a test server with a temporary database.
 * @returns {Promise<{dataDir: string, db: import('better-sqlite3').Database, server: object, base: string}>} Server context.
 */
async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "warp-registry-test-"));
  const db = openDatabase(dataDir);
  const app = createApp({ db, dataDir });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { dataDir, db, server, base: `http://127.0.0.1:${port}` };
}

/**
 * Inserts a new owner into the database and returns a token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} username - The GitHub username.
 * @returns {string} The generated token.
 */
function insertOwner(db, username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO owners (github_username, token_hash, has_published) VALUES (?, ?, 0)",
  ).run(username, hashToken(token));
  return token;
}

/**
 * Publishes a fixture file to the test server.
 * @param {string} base - The base URL of the test server.
 * @param {string} token - The authentication token.
 * @param {string} fixture - The fixture filename.
 * @param {string} [contentType="application/javascript"] - The content type header.
 * @returns {Promise<Response>} The fetch response.
 */
function publish(base, token, fixture, contentType = "application/javascript") {
  const body = fs.readFileSync(path.join(fixturesDir, fixture));
  return fetch(`${base}/v1/publish`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

/**
 * Runs the approve script to approve a pending package version.
 * @param {string} username - The owner's username.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @param {string} dataDir - The data directory path.
 * @returns {string} The script output.
 */
function approve(username, packageId, version, dataDir) {
  return execFileSync(
    process.execPath,
    [path.join(root, "scripts", "approve.js"), username, packageId, version],
    { env: { ...process.env, DATA_DIR: dataDir } },
  ).toString();
}

/**
 * Closes a test server gracefully.
 * @param {object} server - The server instance to close.
 * @returns {Promise<void>} Resolves when the server is closed.
 */
async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

describe("warp-registry publish flow", () => {
  let server;
  let dataDir;
  let db;
  let base;
  let pendingOwnerToken;

  before(async () => {
    ({ server, dataDir, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("publishing for a brand-new owner results in status pending and 404 on info", async () => {
    const token = insertOwner(db, "pendingowner");
    pendingOwnerToken = token;
    const res = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.owner, "pendingowner");
    assert.equal(body.id, "helloworld");
    assert.equal(body.version, "0.1.0");
    assert.equal(body.status, "pending");
    assert.equal(body.url, "/v1/pendingowner/helloworld/0.1.0");

    const row = db
      .prepare(
        `SELECT v.* FROM versions v JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'pendingowner'`,
      )
      .get();
    assert.equal(row.status, "pending");
    assert.equal(
      row.blob_path,
      blobPath(dataDir, "pendingowner", "helloworld", "0.1.0"),
    );
    assert.ok(fs.existsSync(row.blob_path));

    const infoRes = await fetch(`${base}/v1/pendingowner/helloworld`);
    assert.equal(infoRes.status, 404);

    const blobRes = await fetch(`${base}/v1/pendingowner/helloworld/0.1.0`);
    assert.equal(blobRes.status, 404);
  });

  test("after approve, re-publish is immediately published", async () => {
    approve("pendingowner", "helloworld", "0.1.0", dataDir);

    const res = await publish(base, pendingOwnerToken, "helloworld@0.1.0.js");
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.includes("already exists"), true);

    const publishRes = await publishForVersion(
      base,
      pendingOwnerToken,
      "0.1.1",
    );
    assert.equal(publishRes.status, 201);
    const body = await publishRes.json();
    assert.equal(body.status, "published");

    const infoRes = await fetch(`${base}/v1/pendingowner/helloworld`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.latestVersion, "0.1.1");
    assert.deepEqual(info.versions, ["0.1.1", "0.1.0"]);
  });

  test("publishing same (owner, id, version) twice returns 409", async () => {
    const token = insertOwner(db, "dupowner");
    const first = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(first.status, 201);

    const second = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(second.status, 409);
  });

  test("concurrent publishes for the same version yield one 201 and one 409", async () => {
    const token = insertOwner(db, "concurrentowner");

    const [a, b] = await Promise.all([
      publish(base, token, "helloworld@0.1.0.js"),
      publish(base, token, "helloworld@0.1.0.js"),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'concurrentowner'`,
      )
      .all();
    assert.equal(rows.length, 1, "exactly one persisted version row");
    const row = rows[0];
    assert.ok(fs.existsSync(row.blob_path), "blob must exist on disk");

    const storedMeta = JSON.parse(row.meta_json);
    const blobContents = fs.readFileSync(row.blob_path, "utf8");
    assert.equal(storedMeta.version, "0.1.0");
    assert.equal(storedMeta.id, "helloworld");
    assert.equal(
      blobContents.includes(`version: "0.1.0"`),
      true,
      "persisted blob content must match its stored metadata",
    );
  });

  test("malformed meta returns 400 and never executes the file", async () => {
    const token = insertOwner(db, "malowner");
    const res = await publish(base, token, "malformed-meta.js");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /static literal/i);

    assert.equal(
      Object.prototype.hasOwnProperty.call(
        globalThis,
        "__MALFORMED_SIDE_EFFECT__",
      ),
      false,
      "uploaded code must never be executed",
    );

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM owners WHERE github_username='malowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("semver sorts 10.0.0 after 2.0.0", async () => {
    const token = insertOwner(db, "semverowner");
    const dataDirFor = dataDir;

    const publishVersion = async (version) => {
      const body = fs
        .readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"))
        .toString()
        .replace('version: "0.1.0"', `version: "${version}"`)
        .replace('id: "helloworld"', 'id: "semverpkg"');
      const res = await fetch(`${base}/v1/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/javascript",
          Authorization: `Bearer ${token}`,
        },
        body,
      });
      assert.equal(res.status, 201);
      const outer = await res.json();
      approve(outer.owner, outer.id, outer.version, dataDirFor);
    };

    await publishVersion("2.0.0");
    await publishVersion("10.0.0");

    const infoRes = await fetch(`${base}/v1/semverowner/semverpkg`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.latestVersion, "10.0.0");

    const latestRes = await fetch(`${base}/v1/semverowner/semverpkg/latest`);
    assert.equal(latestRes.status, 200);
    const latestBody = await latestRes.text();
    assert.match(latestBody, /"10\.0\.0"/);
  });

  test("invalid Bearer token gets 401", async () => {
    const res = await publish(
      base,
      "definitely-not-a-valid-token",
      "helloworld@0.1.0.js",
    );
    assert.equal(res.status, 401);
  });

  test("non-semver meta.version is rejected with 400 and never persisted", async () => {
    const token = insertOwner(db, "badversionowner");
    const body = fs
      .readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"))
      .toString()
      .replace('version: "0.1.0"', 'version: "not-a-version"');
    const res = await fetch(`${base}/v1/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/javascript",
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.equal(res.status, 400);
    const parsed = await res.json();
    assert.match(parsed.error, /valid semver/i);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM owners WHERE github_username='badversionowner')",
      )
      .get().c;
    assert.equal(count, 0);
    assert.equal(
      fs.existsSync(
        blobPath(dataDir, "badversionowner", "helloworld", "not-a-version"),
      ),
      false,
      "blob must not be written to disk for an invalid version",
    );
  });

  test("nested Warp declaration inside a function is rejected with 400", async () => {
    const token = insertOwner(db, "nestedwarpowner");
    const res = await publish(base, token, "nested-warp.js");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /No\s+`const Warp`\s+object declaration found/i);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM owners WHERE github_username='nestedwarpowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("reconcile does not publish an unapproved version when another is approved", async () => {
    const token = insertOwner(db, "reconcileowner");
    const a = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(a.status, 201);
    const bodyA = await a.json();
    assert.equal(bodyA.status, "pending");

    const b = await publishForVersion(base, token, "0.2.0");
    assert.equal(b.status, 201);
    const bodyB = await b.json();
    assert.equal(bodyB.status, "pending");

    approve("reconcileowner", "helloworld", "0.1.0", dataDir);
    reconcileStagedVersions(db, dataDir);

    const rows = db
      .prepare(
        `SELECT v.version, v.status FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'reconcileowner' ORDER BY v.version`,
      )
      .all();
    assert.deepEqual(rows, [
      { version: "0.1.0", status: "published" },
      { version: "0.2.0", status: "pending" },
    ]);
  });

  test("reconcile finalizes a staging row whose blob became durable", async () => {
    const token = insertOwner(db, "stagingowner");
    const res = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, "pending");

    db.prepare(
      `UPDATE versions SET status = 'staging', final_status = 'published'
       WHERE owner_id = (SELECT id FROM owners WHERE github_username = 'stagingowner')`,
    ).run();
    reconcileStagedVersions(db, dataDir);

    const row = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'stagingowner'`,
      )
      .get();
    assert.equal(row.status, "published");
  });

  test("reconcile deletes a staging row whose blob never became durable", async () => {
    const token = insertOwner(db, "stagingmissingowner");
    const res = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(res.status, 201);

    fs.rmSync(blobPath(dataDir, "stagingmissingowner", "helloworld", "0.1.0"));
    db.prepare(
      `UPDATE versions SET status = 'staging'
       WHERE owner_id = (SELECT id FROM owners WHERE github_username = 'stagingmissingowner')`,
    ).run();
    reconcileStagedVersions(db, dataDir);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM owners WHERE github_username='stagingmissingowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });
});

/**
 * Publishes a modified version of the helloworld fixture with a custom version.
 * @param {string} base - The base URL of the test server.
 * @param {string} token - The authentication token.
 * @param {string} version - The version string to use.
 * @returns {Promise<Response>} The fetch response.
 */
async function publishForVersion(base, token, version) {
  const body = fs
    .readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"))
    .toString()
    .replace('version: "0.1.0"', `version: "${version}"`);
  return fetch(`${base}/v1/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/javascript",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}
