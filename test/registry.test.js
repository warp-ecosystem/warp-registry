import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
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
 * Runs the approve script asynchronously to approve a pending package version.
 * @param {string} username - The owner's username.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @param {string} dataDir - The data directory path.
 * @returns {Promise<string>} The script output.
 */
function approveAsync(username, packageId, version, dataDir) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(root, "scripts", "approve.js"), username, packageId, version],
      { env: { ...process.env, DATA_DIR: dataDir } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`approve failed: ${stderr.toString()}`));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
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

  test("concurrent same version publish is reported as a duplicate-version conflict, not an owner-level conflict", async () => {
    const token = insertOwner(db, "concurrentdupver");
    const body = fs.readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"));
    const encoder = new TextEncoder();

    const makeStreamedPublish = () => {
      let finishBody;
      const bodyReady = new Promise((r) => (finishBody = r));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          bodyReady.then(() => controller.close());
        },
      });
      const req = fetch(`${base}/v1/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/javascript",
          Authorization: `Bearer ${token}`,
        },
        body: stream,
        duplex: "half",
      });
      return { req, finishBody };
    };

    const first = makeStreamedPublish();
    const second = makeStreamedPublish();

    await new Promise((r) => setTimeout(r, 80));
    first.finishBody();
    second.finishBody();

    const [a, b] = await Promise.all([first.req, second.req]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rejected = a.status === 409 ? a : b;
    const rejectedBody = await rejected.json();
    assert.match(rejectedBody.error, /already exists/i);
    assert.doesNotMatch(rejectedBody.error, /awaiting review/i);
  });

  test("concurrent publishes for the same unapproved owner with different versions yield one 201 and one 409", async () => {
    const token = insertOwner(db, "concurrentdiffowner");

    const [a, b] = await Promise.all([
      publishForVersion(base, token, "0.1.0"),
      publishForVersion(base, token, "0.2.0"),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rejected = a.status === 409 ? a : b;
    const rejectedBody = await rejected.json();
    assert.match(rejectedBody.error, /already awaiting review/i);

    const rows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'concurrentdiffowner'`,
      )
      .all();
    assert.equal(rows.length, 1, "exactly one version row persisted");
    assert.equal(rows[0].status, "pending");
    assert.ok(fs.existsSync(rows[0].blob_path), "blob must exist on disk");
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
      if (outer.status === "pending") {
        approve(outer.owner, outer.id, outer.version, dataDirFor);
      }
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
    assert.equal(b.status, 409);
    const bodyB = await b.json();
    assert.match(bodyB.error, /already awaiting review/i);

    approve("reconcileowner", "helloworld", "0.1.0", dataDir);
    reconcileStagedVersions(db, dataDir);

    const rows = db
      .prepare(
        `SELECT v.version, v.status FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'reconcileowner' ORDER BY v.version`,
      )
      .all();
    assert.deepEqual(rows, [{ version: "0.1.0", status: "published" }]);
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

  test("approval does not miss a version during an in-flight staging->pending transition", async () => {
    const token = insertOwner(db, "transitionowner");
    const res = await publish(base, token, "helloworld@0.1.0.js");
    assert.equal(res.status, 201);

    assert.ok(
      fs.existsSync(
        blobPath(dataDir, "transitionowner", "helloworld", "0.1.0"),
      ),
      "blob must be durable during the transition window",
    );

    // A second connection holds the write lock with the transition in flight:
    // the blob is already durable but the row is still 'staging' (final
    // status 'pending'), exactly the state between the blob rename and the
    // status flip. Approval must be mutually exclusive with this transition.
    const other = openDatabase(dataDir);
    other.exec("BEGIN IMMEDIATE");
    other
      .prepare(
        `UPDATE versions SET status = 'staging', final_status = 'pending'
         WHERE owner_id = (SELECT id FROM owners WHERE github_username = 'transitionowner')`,
      )
      .run();

    const approving = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return approveAsync("transitionowner", "helloworld", "0.1.0", dataDir);
    })();

    other
      .prepare(
        `UPDATE versions SET status = 'pending'
         WHERE owner_id = (SELECT id FROM owners WHERE github_username = 'transitionowner')`,
      )
      .run();
    other.exec("COMMIT");
    other.close();

    await approving;

    const rows = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'transitionowner'`,
      )
      .all();
    assert.deepEqual(rows, [{ status: "published" }]);
  });

  test("publish is published, not left pending, when approval completes before reservation", async () => {
    const token = insertOwner(db, "raceowner");
    db.prepare(
      `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
       VALUES ((SELECT id FROM owners WHERE github_username = 'raceowner'),
               'pkga', '0.1.0', 'pending', 'pending', '{}', '/tmp/nonexistent')`,
    ).run();

    const body = buildCustomBody({ id: "pkgb", version: "0.1.0" });
    const encoder = new TextEncoder();
    let finishBody;
    const bodyReady = new Promise((r) => (finishBody = r));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        bodyReady.then(() => controller.close());
      },
    });

    // Stream the request body so the publish handler reads the owner
    // (has_published=0) and then parks awaiting readRawBody.
    const publishing = fetch(`${base}/v1/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/javascript",
        Authorization: `Bearer ${token}`,
      },
      body: stream,
      duplex: "half",
    });

    // While the handler is parked, approval completes: the pending version is
    // published and the owner becomes approved.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      db
        .prepare(
          "SELECT has_published FROM owners WHERE github_username = 'raceowner'",
        )
        .get().has_published,
      0,
      "handler must have read the owner before approval completed",
    );
    db.prepare(
      `UPDATE versions SET status = 'published'
       WHERE owner_id = (SELECT id FROM owners WHERE github_username = 'raceowner')
         AND package_id = 'pkga'`,
    ).run();
    db.prepare(
      `UPDATE owners SET has_published = 1 WHERE github_username = 'raceowner'`,
    ).run();
    finishBody();

    const res = await publishing;
    assert.equal(res.status, 201);
    const body2 = await res.json();
    assert.equal(body2.status, "published");

    const rows = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'raceowner' AND v.package_id = 'pkgb'`,
      )
      .all();
    assert.deepEqual(rows, [{ status: "published" }]);
  });
});

/**
 * Inserts a brand approved owner (has_published=1) and returns a token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} username - The GitHub username.
 * @returns {string} The generated token.
 */
function insertApprovedOwner(db, username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO owners (github_username, token_hash, has_published) VALUES (?, ?, 1)",
  ).run(username, hashToken(token));
  return token;
}

/**
 * Builds a publish body from the helloworld fixture with overrides applied.
 * @param {object} [overrides] - Field overrides for id, name, description, version.
 * @returns {string} The publish body.
 */
function buildCustomBody(overrides = {}) {
  let body = fs
    .readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"))
    .toString()
    .replace('version: "0.1.0"', `version: "${overrides.version || "0.1.0"}"`)
    .replace('id: "helloworld"', `id: "${overrides.id || "helloworld"}"`)
    .replace('name: "It works!"', `name: "${overrides.name || "It works!"}"`)
    .replace(
      'description: "A description of the extension."',
      `description: "${overrides.description || "A description of the extension."}"`,
    );
  return body;
}

/**
 * Publishes a raw body string to the server.
 * @param {string} base - The base URL of the test server.
 * @param {string} token - The authentication token.
 * @param {string} body - The request body.
 * @returns {Promise<Response>} The fetch response.
 */
function publishRaw(base, token, body) {
  return fetch(`${base}/v1/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/javascript",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

describe("warp-registry search endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const nameToken = insertApprovedOwner(db, "nameowner");
    await publishRaw(
      base,
      nameToken,
      buildCustomBody({
        id: "namesearch",
        name: "ZebraWidget",
        description: "a widget for tests",
      }),
    );

    const idToken = insertApprovedOwner(db, "idowner");
    await publishRaw(
      base,
      idToken,
      buildCustomBody({
        id: "unicornpkg",
        name: "Whatever",
        description: "another package",
      }),
    );

    const ownerToken = insertApprovedOwner(db, "ownerhunt");
    await publishRaw(
      base,
      ownerToken,
      buildCustomBody({ id: "pkgx", name: "Whatever Two" }),
    );

    const descToken = insertApprovedOwner(db, "descowner");
    await publishRaw(
      base,
      descToken,
      buildCustomBody({
        id: "pkgy",
        name: "Whatever Three",
        description: "purplebanana",
      }),
    );

    const unicodeToken = insertApprovedOwner(db, "unicodeowner");
    await publishRaw(
      base,
      unicodeToken,
      buildCustomBody({
        id: "opiesearch",
        name: "ÆnigmaWidget",
        description: "unicode name",
      }),
    );

    const multiverToken = insertApprovedOwner(db, "multiver");
    await publishRaw(
      base,
      multiverToken,
      buildCustomBody({ id: "mypkg", name: "MultiVersion", version: "0.1.0" }),
    );
    await publishRaw(
      base,
      multiverToken,
      buildCustomBody({ id: "mypkg", name: "MultiVersion", version: "0.2.0" }),
    );

    const sharpSToken = insertApprovedOwner(db, "sharpssowner");
    await publishRaw(
      base,
      sharpSToken,
      buildCustomBody({
        id: "sharppkg",
        name: "Stra\u00DFe",
        description: "German sharp s package",
      }),
    );

    const longSToken = insertApprovedOwner(db, "longsowner");
    await publishRaw(
      base,
      longSToken,
      buildCustomBody({
        id: "longspkg",
        name: "Ma\u017Fs",
        description: "Latin long s package",
      }),
    );

    const pendingToken = insertOwner(db, "pendingsearch");
    await publishRaw(
      base,
      pendingToken,
      buildCustomBody({
        id: "pkgpending",
        name: "PineappleExpress",
        description: "pending only",
      }),
    );
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("empty or missing q returns 400", async () => {
    const missing = await fetch(`${base}/v1/search`);
    assert.equal(missing.status, 400);

    const empty = await fetch(`${base}/v1/search?q=`);
    assert.equal(empty.status, 400);

    const blank = await fetch(`${base}/v1/search?q=%20%20`);
    assert.equal(blank.status, 400);
  });

  test("search matches on display name (case-insensitive)", async () => {
    const res = await fetch(`${base}/v1/search?q=zebrawidget`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["namesearch"],
    );
  });

  test("search matches on display name with non-ASCII case folding", async () => {
    const res = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("ænigmawidget")}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["opiesearch"],
    );
  });

  test("search matches ß-expanded names via full Unicode case folding", async () => {
    const lower = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("strasse")}`,
    );
    assert.equal(lower.status, 200);
    const lowerBody = await lower.json();
    assert.deepEqual(
      lowerBody.results.map((r) => r.id),
      ["sharppkg"],
      "strasse should match Straße",
    );

    const upper = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("STRASSE")}`,
    );
    assert.equal(upper.status, 200);
    const upperBody = await upper.json();
    assert.deepEqual(
      upperBody.results.map((r) => r.id),
      ["sharppkg"],
      "STRASSE should match Straße",
    );

    const direct = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("Straße")}`,
    );
    assert.equal(direct.status, 200);
    const directBody = await direct.json();
    assert.deepEqual(
      directBody.results.map((r) => r.id),
      ["sharppkg"],
      "Straße should match Straße",
    );
  });

  test("search matches names containing U+017F (long s) via full case folding", async () => {
    const stdForm = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("mass")}`,
    );
    assert.equal(stdForm.status, 200);
    const stdBody = await stdForm.json();
    assert.deepEqual(
      stdBody.results.map((r) => r.id),
      ["longspkg"],
      "mass should match Ma\u017Fs (long s folds to s)",
    );

    const direct = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("Ma\u017Fs")}`,
    );
    assert.equal(direct.status, 200);
    const directBody = await direct.json();
    assert.deepEqual(
      directBody.results.map((r) => r.id),
      ["longspkg"],
      "Ma\u017Fs should match itself",
    );
  });

  test("search matches on package_id", async () => {
    const res = await fetch(`${base}/v1/search?q=unicornpkg`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["unicornpkg"],
    );
  });

  test("search matches on owner github_username", async () => {
    const res = await fetch(`${base}/v1/search?q=ownerhunt`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pkgx"],
    );
  });

  test("search matches on description", async () => {
    const res = await fetch(`${base}/v1/search?q=purplebanana`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pkgy"],
    );
  });

  test("search does not return a pending package even if its name matches", async () => {
    const res = await fetch(`${base}/v1/search?q=PineappleExpress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.results, []);
  });

  test("search never returns duplicates for a package with multiple published versions", async () => {
    const res = await fetch(`${base}/v1/search?q=multiversion`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].id, "mypkg");
    assert.equal(body.results[0].latestVersion, "0.2.0");
  });

  test("discovery picks latestVersion by semantic version, not publication order", async () => {
    const token = insertApprovedOwner(db, "backportowner");
    const publishVersion = async (version) => {
      const res = await publishRaw(
        base,
        token,
        buildCustomBody({ id: "backportpkg", version }),
      );
      assert.equal(res.status, 201);
    };

    await publishVersion("2.0.0");
    await publishVersion("1.5.1");

    const searchRes = await fetch(`${base}/v1/search?q=backportpkg`);
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.results.length, 1);
    assert.equal(
      searchBody.results[0].latestVersion,
      "2.0.0",
      "lower version published later must not supersede the higher version",
    );

    const infoRes = await fetch(`${base}/v1/backportowner/backportpkg`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(
      info.latestVersion,
      "2.0.0",
      "GET /v1/:owner/:id stays consistent with discovery",
    );
  });
});

describe("warp-registry semver precedence in discovery routes", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const setCreatedAt = (owner, id, version, createdAt) => {
      db.prepare(
        `UPDATE versions SET created_at = ?
         WHERE owner_id = (SELECT id FROM owners WHERE github_username = ?)
           AND package_id = ? AND version = ?`,
      ).run(createdAt, owner, id, version);
    };

    const token = insertApprovedOwner(db, "preowner");
    const publishVersion = async (pkgId, version) => {
      const res = await publishRaw(
        base,
        token,
        buildCustomBody({ id: pkgId, name: pkgId, version }),
      );
      assert.equal(res.status, 201);
    };

    await publishVersion("releasepkg", "1.0.0");
    await publishVersion("releasepkg", "1.0.0-beta.1");
    setCreatedAt("preowner", "releasepkg", "1.0.0", "2024-01-01 10:00:00");
    setCreatedAt(
      "preowner",
      "releasepkg",
      "1.0.0-beta.1",
      "2024-01-02 10:00:00",
    );

    await publishVersion("numericprepkg", "1.0.0-beta.10");
    await publishVersion("numericprepkg", "1.0.0-beta.2");
    setCreatedAt(
      "preowner",
      "numericprepkg",
      "1.0.0-beta.10",
      "2024-01-01 10:00:00",
    );
    setCreatedAt(
      "preowner",
      "numericprepkg",
      "1.0.0-beta.2",
      "2024-01-02 10:00:00",
    );

    await publishVersion("alphapkg", "1.0.0-beta");
    await publishVersion("alphapkg", "1.0.0-alpha");
    setCreatedAt("preowner", "alphapkg", "1.0.0-beta", "2024-01-01 10:00:00");
    setCreatedAt("preowner", "alphapkg", "1.0.0-alpha", "2024-01-02 10:00:00");

    await publishVersion("numericpkg", "1.0.0-alpha");
    await publishVersion("numericpkg", "1.0.0-1");
    setCreatedAt(
      "preowner",
      "numericpkg",
      "1.0.0-alpha",
      "2024-01-01 10:00:00",
    );
    setCreatedAt("preowner", "numericpkg", "1.0.0-1", "2024-01-02 10:00:00");
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  async function latestFromSearchAndPackages(pkgId) {
    const searchRes = await fetch(
      `${base}/v1/search?q=${encodeURIComponent(pkgId)}`,
    );
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    const searchMatch = searchBody.results.find((r) => r.id === pkgId);

    const packagesRes = await fetch(`${base}/v1/packages?limit=50`);
    assert.equal(packagesRes.status, 200);
    const packagesBody = await packagesRes.json();
    const packagesMatch = packagesBody.packages.find((p) => p.id === pkgId);

    return { searchMatch, packagesMatch };
  }

  async function assertLatest(pkgId, expected) {
    const { searchMatch, packagesMatch } =
      await latestFromSearchAndPackages(pkgId);
    assert.ok(searchMatch, `search must return ${pkgId}`);
    assert.equal(searchMatch.latestVersion, expected);
    assert.ok(packagesMatch, `packages must return ${pkgId}`);
    assert.equal(packagesMatch.latestVersion, expected);
  }

  test("a normal release beats an identical-core prerelease regardless of created_at", async () => {
    await assertLatest("releasepkg", "1.0.0");
  });

  test("numeric prerelease identifiers sort numerically, not lexically", async () => {
    await assertLatest("numericprepkg", "1.0.0-beta.10");
  });

  test("alphanumeric prerelease identifiers sort by ASCII order", async () => {
    await assertLatest("alphapkg", "1.0.0-beta");
  });

  test("numeric prerelease identifiers sort below alphanumeric ones", async () => {
    await assertLatest("numericpkg", "1.0.0-alpha");
  });
});

describe("warp-registry search LIKE escaping", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const underscoreToken = insertApprovedOwner(db, "usowner");
    await publishRaw(
      base,
      underscoreToken,
      buildCustomBody({ id: "foo_bar", name: "Foo Bar" }),
    );

    const wildcardishToken = insertApprovedOwner(db, "usowner2");
    await publishRaw(
      base,
      wildcardishToken,
      buildCustomBody({ id: "fooxbar", name: "Foo X Bar" }),
    );

    const percentToken = insertApprovedOwner(db, "pctowner");
    await publishRaw(
      base,
      percentToken,
      buildCustomBody({ id: "pctpkg1", description: "100%guaranteed" }),
    );

    const wildcardPctToken = insertApprovedOwner(db, "pctowner2");
    await publishRaw(
      base,
      wildcardPctToken,
      buildCustomBody({ id: "pctpkg2", description: "100x guaranteed" }),
    );
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("underscore in q is matched literally, not as a single-character wildcard", async () => {
    const res = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("foo_bar")}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["foo_bar"],
    );
  });

  test("percent in q is matched literally, not as a wildcard", async () => {
    const res = await fetch(
      `${base}/v1/search?q=${encodeURIComponent("100%guaranteed")}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pctpkg1"],
    );
  });
});

describe("warp-registry packages pagination", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const setCreatedAt = (owner, id, createdAt) => {
      db.prepare(
        `UPDATE versions SET created_at = ?
         WHERE owner_id = (SELECT id FROM owners WHERE github_username = ?)
           AND package_id = ?`,
      ).run(createdAt, owner, id);
    };

    const tokenA = insertApprovedOwner(db, "paga");
    await publishRaw(
      base,
      tokenA,
      buildCustomBody({ id: "aaa", name: "Package A", version: "1.0.0" }),
    );
    setCreatedAt("paga", "aaa", "2024-01-01 10:00:00");

    const tokenB = insertApprovedOwner(db, "pagb");
    await publishRaw(
      base,
      tokenB,
      buildCustomBody({ id: "bbb", name: "Package B", version: "1.0.0" }),
    );
    setCreatedAt("pagb", "bbb", "2024-01-02 10:00:00");

    const tokenC = insertApprovedOwner(db, "pagc");
    await publishRaw(
      base,
      tokenC,
      buildCustomBody({ id: "ccc", name: "Package C", version: "1.0.0" }),
    );
    setCreatedAt("pagc", "ccc", "2024-01-03 10:00:00");
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("returns results in recency order and paginates with nextCursor", async () => {
    const page1Res = await fetch(`${base}/v1/packages?limit=2`);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.deepEqual(
      page1.packages.map((p) => p.id),
      ["ccc", "bbb"],
    );
    assert.ok(page1.nextCursor, "first page must have a nextCursor");

    const page2Res = await fetch(
      `${base}/v1/packages?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.deepEqual(
      page2.packages.map((p) => p.id),
      ["aaa"],
    );
    assert.equal(page2.nextCursor, null, "last page must have null nextCursor");
  });

  test("response shape includes owner, id, name, description, latestVersion, publishedAt", async () => {
    const res = await fetch(`${base}/v1/packages?limit=1`);
    const body = await res.json();
    const pkg = body.packages[0];
    assert.deepEqual(Object.keys(pkg).sort(), [
      "description",
      "id",
      "latestVersion",
      "name",
      "owner",
      "publishedAt",
    ]);
    assert.equal(pkg.id, "ccc");
    assert.equal(pkg.name, "Package C");
    assert.equal(pkg.latestVersion, "1.0.0");
    assert.equal(pkg.publishedAt, "2024-01-03 10:00:00");
  });
});

describe("warp-registry packages pagination: limit and cursor validation", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const token = insertApprovedOwner(db, "bulkowner");
    for (let i = 0; i < 55; i++) {
      const id = `bulk${String(i).padStart(2, "0")}`;
      await publishRaw(base, token, buildCustomBody({ id, name: `Bulk ${i}` }));
    }
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("limit above 50 is clamped to 50", async () => {
    const res = await fetch(`${base}/v1/packages?limit=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.packages.length, 50);
    assert.ok(body.nextCursor, "a nextCursor should remain after clamping");
  });

  test("non-positive or non-integer limit returns 400", async () => {
    const zero = await fetch(`${base}/v1/packages?limit=0`);
    assert.equal(zero.status, 400);

    const negative = await fetch(`${base}/v1/packages?limit=-5`);
    assert.equal(negative.status, 400);

    const nonInteger = await fetch(`${base}/v1/packages?limit=2.5`);
    assert.equal(nonInteger.status, 400);

    const notANumber = await fetch(`${base}/v1/packages?limit=abc`);
    assert.equal(notANumber.status, 400);
  });

  test("invalid cursor returns 400", async () => {
    const notBase64 = await fetch(`${base}/v1/packages?cursor=not-a-cursor`);
    assert.equal(notBase64.status, 400);

    const badJson = await fetch(
      `${base}/v1/packages?cursor=${encodeURIComponent(Buffer.from("not json").toString("base64"))}`,
    );
    assert.equal(badJson.status, 400);
  });
});

describe("warp-registry stats endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const token1 = insertApprovedOwner(db, "statowner1");
    await publishRaw(
      base,
      token1,
      buildCustomBody({ id: "statpkg", version: "0.1.0" }),
    );
    await publishRaw(
      base,
      token1,
      buildCustomBody({ id: "statpkg", version: "0.2.0" }),
    );

    const token2 = insertApprovedOwner(db, "statowner2");
    await publishRaw(
      base,
      token2,
      buildCustomBody({ id: "otherpkg", version: "1.0.0" }),
    );

    const pendingToken = insertOwner(db, "statpendingowner");
    await publishRaw(
      base,
      pendingToken,
      buildCustomBody({ id: "pendingpkg", version: "0.1.0" }),
    );
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("stats reflect published pairs, pending rows, and distinct authors", async () => {
    const res = await fetch(`${base}/v1/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, 2);
    assert.equal(body.pending, 1);
    assert.equal(body.authors, 2);
  });
});

describe("warp-registry second pending publish guard", () => {
  let server;
  let dataDir;
  let db;
  let base;

  before(async () => {
    ({ server, dataDir, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("an unapproved owner is blocked from a second pending publish, then unblocked once approved", async () => {
    const token = insertOwner(db, "pendingguard");

    const aRes = await publishRaw(
      base,
      token,
      buildCustomBody({ id: "pkga", version: "0.1.0" }),
    );
    assert.equal(aRes.status, 201);
    assert.equal((await aRes.json()).status, "pending");

    const bRes = await publishRaw(
      base,
      token,
      buildCustomBody({ id: "pkgb", version: "0.1.0" }),
    );
    assert.equal(bRes.status, 409);
    const bBody = await bRes.json();
    assert.match(bBody.error, /already awaiting review/i);

    const bRows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = 'pendingguard' AND v.package_id = 'pkgb'`,
      )
      .all();
    assert.equal(
      bRows.length,
      0,
      "no row may be written for the blocked publish",
    );
    assert.equal(
      fs.existsSync(blobPath(dataDir, "pendingguard", "pkgb", "0.1.0")),
      false,
      "no blob may be written for the blocked publish",
    );

    approve("pendingguard", "pkga", "0.1.0", dataDir);

    const bRetry = await publishRaw(
      base,
      token,
      buildCustomBody({ id: "pkgb", version: "0.1.0" }),
    );
    assert.equal(bRetry.status, 201);
    const bRetryBody = await bRetry.json();
    assert.equal(bRetryBody.status, "published");
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
