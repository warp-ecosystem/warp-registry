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
  hashPassword,
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
 * Signs up a user via the API and returns the auth token.
 * @param {string} base - The base URL of the test server.
 * @param {string} namespace - The user namespace.
 * @param {string} [password="testpassword123"] - The password.
 * @param {string} [displayName=""] - The display name.
 * @returns {Promise<{token: string, user: object}>} The auth token and user object.
 */
async function signup(
  base,
  namespace,
  password = "testpassword123",
  displayName = "",
) {
  const res = await fetch(`${base}/v2/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namespace, password, displayName }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  return { token: body.token, user: body.user };
}

/**
 * Inserts a new owner directly into the database and returns a token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} namespace - The user namespace.
 * @param {boolean} [hasPublished=false] - Whether the user has published before.
 * @returns {Promise<string>} The generated token.
 */
async function insertOwner(db, namespace, hasPublished = false) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (namespace, display_name, password_hash, type, has_published) VALUES (?, '', ?, 'normal', ?)",
  ).run(namespace, await hashPassword("testpassword123"), hasPublished ? 1 : 0);
  db.prepare("INSERT INTO auth_tokens (user_id, token_hash) VALUES (?, ?)").run(
    db.prepare("SELECT id FROM users WHERE namespace = ?").get(namespace).id,
    hashToken(token),
  );
  return token;
}

/**
 * Inserts a brand approved owner (has_published=1) and returns a token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} namespace - The user namespace.
 * @returns {Promise<string>} The generated token.
 */
function insertApprovedOwner(db, namespace) {
  return insertOwner(db, namespace, true);
}

/**
 * Inserts an admin user directly into the database and returns a token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} namespace - The admin namespace.
 * @returns {Promise<string>} The generated token.
 */
async function insertAdmin(db, namespace) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO users (namespace, display_name, password_hash, type, has_published) VALUES (?, '', ?, 'admin', 1)",
  ).run(namespace, await hashPassword("testpassword123"));
  db.prepare("INSERT INTO auth_tokens (user_id, token_hash) VALUES (?, ?)").run(
    db.prepare("SELECT id FROM users WHERE namespace = ?").get(namespace).id,
    hashToken(token),
  );
  return token;
}

/**
 * Builds a publish body from the helloworld fixture with overrides applied.
 * @param {object} [overrides] - Field overrides for id, name, description, version.
 * @returns {object} The publish request body.
 */
function buildPublishBody(overrides = {}) {
  const source = fs
    .readFileSync(path.join(fixturesDir, "helloworld@0.1.0.js"))
    .toString()
    .replace('version: "0.1.0"', `version: "${overrides.version || "0.1.0"}"`)
    .replace('id: "helloworld"', `id: "${overrides.id || "helloworld"}"`)
    .replace('name: "It works!"', `name: "${overrides.name || "It works!"}"`)
    .replace(
      'description: "A description of the extension."',
      `description: "${overrides.description || "A description of the extension."}"`,
    );
  return {
    id: overrides.id || "helloworld",
    meta: {
      class: "HelloWorld",
      name: overrides.name || "It works!",
      id: overrides.id || "helloworld",
      license: "Apache-2.0",
      authors: ["test"],
      description: overrides.description || "A description of the extension.",
      version: overrides.version || "0.1.0",
    },
    extensionBlob: source,
  };
}

/**
 * Publishes to the v2 publish endpoint.
 * @param {string} base - The base URL of the test server.
 * @param {string} token - The authentication token.
 * @param {object} body - The publish request body.
 * @returns {Promise<Response>} The fetch response.
 */
function publish(base, token, body) {
  return fetch(`${base}/v2/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Runs the approve script to approve a pending package version.
 * @param {string} namespace - The owner's namespace.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @param {string} dataDir - The data directory path.
 * @returns {string} The script output.
 */
function approve(namespace, packageId, version, dataDir) {
  return execFileSync(
    process.execPath,
    [path.join(root, "scripts", "approve.js"), namespace, packageId, version],
    { env: { ...process.env, DATA_DIR: dataDir } },
  ).toString();
}

/**
 * Runs the approve script asynchronously to approve a pending package version.
 * @param {string} namespace - The owner's namespace.
 * @param {string} packageId - The package identifier.
 * @param {string} version - The package version.
 * @param {string} dataDir - The data directory path.
 * @returns {Promise<string>} The script output.
 */
function approveAsync(namespace, packageId, version, dataDir) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(root, "scripts", "approve.js"), namespace, packageId, version],
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

/**
 * Publishes a modified version of the helloworld fixture with a custom version.
 * @param {string} base - The base URL of the test server.
 * @param {string} token - The authentication token.
 * @param {string} version - The version string to use.
 * @returns {Promise<Response>} The fetch response.
 */
async function publishForVersion(base, token, version) {
  return publish(base, token, buildPublishBody({ version }));
}

describe("warp-registry v2 auth flow", () => {
  let server;
  let base;

  before(async () => {
    ({ server, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
  });

  test("signup creates a user and returns token", async () => {
    const { token, user } = await signup(base, "newuser");
    assert.ok(token, "token should be returned");
    assert.equal(user.namespace, "newuser");
    assert.equal(user.type, "normal");
    assert.deepEqual(user.extensions, []);
  });

  test("signup with duplicate namespace returns 409", async () => {
    await signup(base, "dupuser");
    const res = await fetch(`${base}/v2/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "dupuser", password: "password1234" }),
    });
    assert.equal(res.status, 409);
  });

  test("signup with short password returns 400", async () => {
    const res = await fetch(`${base}/v2/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "shortpw", password: "short" }),
    });
    assert.equal(res.status, 400);
  });

  test("signup with invalid namespace returns 400", async () => {
    const res = await fetch(`${base}/v2/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "INVALID!", password: "password1234" }),
    });
    assert.equal(res.status, 400);
  });

  test("login with valid credentials returns token", async () => {
    await signup(base, "logintest", "mypassword123");
    const res = await fetch(`${base}/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace: "logintest",
        password: "mypassword123",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token);
    assert.equal(body.user.namespace, "logintest");
  });

  test("login with wrong password returns 401", async () => {
    await signup(base, "wrongpw", "mypassword123");
    const res = await fetch(`${base}/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "wrongpw", password: "wrongpassword" }),
    });
    assert.equal(res.status, 401);
  });

  test("logout revokes token", async () => {
    const { token } = await signup(base, "logouttest");
    const logoutRes = await fetch(`${base}/v2/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(logoutRes.status, 200);

    const publishRes = await publish(
      base,
      token,
      buildPublishBody({ id: "testpkg" }),
    );
    assert.equal(publishRes.status, 401);
  });
});

describe("warp-registry v2 auth hardening", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  const login = (namespace, password) =>
    fetch(`${base}/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ namespace, password }),
    });

  test("login is throttled with 429 after repeated failures", async () => {
    await signup(base, "ratelimituser", "correct-password-1");

    let status;
    for (let i = 1; i <= 4; i += 1) {
      status = (await login("ratelimituser", "wrong-password")).status;
      assert.equal(status, 401);
    }
    assert.equal((await login("ratelimituser", "wrong-password")).status, 429);
    assert.equal(
      (await login("ratelimituser", "correct-password-1")).status,
      429,
      "a correct password is still rejected while throttled",
    );
  });

  test("expired tokens are rejected with 401", async () => {
    const { token } = await signup(base, "expireduser");
    db.prepare(
      `UPDATE auth_tokens SET expires_at = '2000-01-01T00:00:00.000Z'
       WHERE user_id = (SELECT id FROM users WHERE namespace = 'expireduser')`,
    ).run();

    const res = await fetch(`${base}/v2/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);

    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS c FROM auth_tokens
         WHERE user_id = (SELECT id FROM users WHERE namespace = 'expireduser')`,
      )
      .get().c;
    assert.equal(remaining, 0, "expired token rows are cleaned up");
  });

  test("password change revokes all existing tokens", async () => {
    const { token } = await signup(base, "pwdchanger", "old-password-1");
    const patch = await fetch(`${base}/v2/users/pwdchanger`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ password: "new-password-1" }),
    });
    assert.equal(patch.status, 200);

    const revoked = await fetch(`${base}/v2/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(
      revoked.status,
      401,
      "the old token must no longer authenticate after a password change",
    );

    const loginRes = await login("pwdchanger", "new-password-1");
    assert.equal(loginRes.status, 200);
    const body = await loginRes.json();
    assert.ok(body.token);
  });

  test("signup is throttled with 429 after repeated attempts", async () => {
    const fresh = await startServer();
    try {
      const attempt = (namespace) =>
        fetch(`${fresh.base}/v2/auth/signup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace, password: "password1234" }),
        });

      for (let i = 1; i <= 4; i += 1) {
        assert.equal((await attempt(`ratelimit-s${i}`)).status, 201);
      }
      assert.equal((await attempt("ratelimit-s5")).status, 201);
      assert.equal(
        (await attempt("ratelimit-s6")).status,
        429,
        "signup throttling is keyed by client IP, so a namespace never attempted before is throttled too once the bucket is exhausted",
      );
    } finally {
      await closeServer(fresh.server);
      fresh.db.close();
    }
  });

  test("concurrent signups from one IP cannot exceed the signup limit", async () => {
    const fresh = await startServer();
    try {
      const attempts = [];
      for (let i = 0; i < 12; i += 1) {
        attempts.push(
          fetch(`${fresh.base}/v2/auth/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              namespace: `concurrent-s${i}`,
              password: "password1234",
            }),
          }),
        );
      }

      const results = await Promise.all(attempts);
      const created = results.filter((r) => r.status === 201);
      const throttled = results.filter((r) => r.status === 429);
      assert.equal(
        created.length,
        5,
        "at most RATE_LIMIT_MAX concurrent signups may succeed",
      );
      assert.ok(
        throttled.length > 0,
        "the remaining concurrent signups are throttled",
      );
    } finally {
      await closeServer(fresh.server);
      fresh.db.close();
    }
  });
});

describe("warp-registry v2 publish flow", () => {
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
    const token = await insertOwner(db, "pendingowner");
    pendingOwnerToken = token;
    const res = await publish(base, token, buildPublishBody());
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.extension.owner, "pendingowner");
    assert.equal(body.extension.id, "helloworld");
    assert.equal(body.extension.approved, false);
    assert.equal(body.publishedUrl, "/v2/@pendingowner/helloworld");

    const row = db
      .prepare(
        `SELECT v.* FROM versions v JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'pendingowner'`,
      )
      .get();
    assert.equal(row.status, "pending");
    assert.equal(
      row.blob_path,
      blobPath(dataDir, "pendingowner", "helloworld", "0.1.0"),
    );
    assert.ok(fs.existsSync(row.blob_path));

    const infoRes = await fetch(`${base}/v2/@pendingowner/helloworld`);
    assert.equal(infoRes.status, 404);

    const blobRes = await fetch(`${base}/v2/@pendingowner/helloworld/0.1.0`);
    assert.equal(blobRes.status, 404);
  });

  test("after approve, re-publish is immediately published", async () => {
    approve("pendingowner", "helloworld", "0.1.0", dataDir);

    const res = await publish(base, pendingOwnerToken, buildPublishBody());
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.includes("already exists"), true);

    const publishRes = await publishForVersion(
      base,
      pendingOwnerToken,
      "0.1.1",
    );
    assert.equal(publishRes.status, 201);
    const body = await publishRes.json();
    assert.equal(body.extension.approved, true);

    const infoRes = await fetch(`${base}/v2/@pendingowner/helloworld`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.deepEqual(info.versions, ["0.1.1", "0.1.0"]);
  });

  test("publishing same (owner, id, version) twice returns 409", async () => {
    const token = await insertOwner(db, "dupowner");
    const first = await publish(base, token, buildPublishBody());
    assert.equal(first.status, 201);

    const second = await publish(base, token, buildPublishBody());
    assert.equal(second.status, 409);
  });

  test("concurrent publishes for the same version yield one 201 and one 409", async () => {
    const token = await insertOwner(db, "concurrentowner");
    const body = buildPublishBody();

    const [a, b] = await Promise.all([
      publish(base, token, body),
      publish(base, token, body),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const rows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'concurrentowner'`,
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
    const token = await insertOwner(db, "concurrentdupver");
    const bodyData = buildPublishBody();
    const encoder = new TextEncoder();

    const makeStreamedPublish = () => {
      let finishBody;
      const bodyReady = new Promise((r) => (finishBody = r));
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(bodyData)));
          bodyReady.then(() => controller.close());
        },
      });
      const req = fetch(`${base}/v2/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

  test("concurrent publishes for the same unapproved owner with different versions yield one 201 and one 403", async () => {
    const token = await insertOwner(db, "concurrentdiffowner");

    const [a, b] = await Promise.all([
      publishForVersion(base, token, "0.1.0"),
      publishForVersion(base, token, "0.2.0"),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 403]);

    const rejected = a.status === 403 ? a : b;
    const rejectedBody = await rejected.json();
    assert.match(rejectedBody.error, /already awaiting review/i);

    const rows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'concurrentdiffowner'`,
      )
      .all();
    assert.equal(rows.length, 1, "exactly one version row persisted");
    assert.equal(rows[0].status, "pending");
    assert.ok(fs.existsSync(rows[0].blob_path), "blob must exist on disk");
  });

  test("malformed meta returns 400 and never executes the file", async () => {
    const token = await insertOwner(db, "malowner");
    const source = fs.readFileSync(
      path.join(fixturesDir, "malformed-meta.js"),
      "utf8",
    );
    const body = {
      id: "malpkg",
      meta: {
        class: "Test",
        name: "Test",
        id: "malpkg",
        license: "MIT",
        authors: ["test"],
        description: "test",
        version: "0.1.0",
      },
      extensionBlob: source,
    };
    const res = await publish(base, token, body);
    assert.equal(res.status, 400);
    const resBody = await res.json();
    assert.match(resBody.error, /static literal/i);

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
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM users WHERE namespace='malowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("semver sorts 10.0.0 after 2.0.0", async () => {
    const token = await insertOwner(db, "semverowner");
    const dataDirFor = dataDir;

    const publishVersion = async (version) => {
      const res = await publish(
        base,
        token,
        buildPublishBody({ id: "semverpkg", version }),
      );
      assert.equal(res.status, 201);
      const outer = await res.json();
      if (!outer.extension.approved) {
        approve(outer.extension.owner, outer.extension.id, version, dataDirFor);
      }
    };

    await publishVersion("2.0.0");
    await publishVersion("10.0.0");

    const infoRes = await fetch(`${base}/v2/@semverowner/semverpkg`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.deepEqual(info.versions, ["10.0.0", "2.0.0"]);

    const latestRes = await fetch(`${base}/v2/@semverowner/semverpkg/latest`);
    assert.equal(latestRes.status, 200);
    const latestBody = await latestRes.text();
    assert.match(latestBody, /"10\.0\.0"/);
  });

  test("invalid Bearer token gets 401", async () => {
    const res = await publish(
      base,
      "definitely-not-a-valid-token",
      buildPublishBody(),
    );
    assert.equal(res.status, 401);
  });

  test("non-semver meta.version is rejected with 400 and never persisted", async () => {
    const token = await insertOwner(db, "badversionowner");
    const body = buildPublishBody({ id: "badverpkg" });
    body.meta.version = "not-a-version";
    body.extensionBlob = body.extensionBlob.replace(
      'version: "0.1.0"',
      'version: "not-a-version"',
    );
    const res = await publish(base, token, body);
    assert.equal(res.status, 400);
    const parsed = await res.json();
    assert.match(parsed.error, /valid semver/i);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM users WHERE namespace='badversionowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("nested Warp declaration inside a function is rejected with 400", async () => {
    const token = await insertOwner(db, "nestedwarpowner");
    const source = fs.readFileSync(
      path.join(fixturesDir, "nested-warp.js"),
      "utf8",
    );
    const body = {
      id: "nestedpkg",
      meta: {
        class: "Test",
        name: "Test",
        id: "nestedpkg",
        license: "MIT",
        authors: ["test"],
        description: "test",
        version: "0.1.0",
      },
      extensionBlob: source,
    };
    const res = await publish(base, token, body);
    assert.equal(res.status, 400);
    const resBody = await res.json();
    assert.match(
      resBody.error,
      /No\s+`const Warp`\s+object declaration found/i,
    );

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM users WHERE namespace='nestedwarpowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("reconcile does not publish an unapproved version when another is approved", async () => {
    const token = await insertOwner(db, "reconcileowner");
    const a = await publish(base, token, buildPublishBody());
    assert.equal(a.status, 201);
    const bodyA = await a.json();
    assert.equal(bodyA.extension.approved, false);

    const b = await publishForVersion(base, token, "0.2.0");
    assert.equal(b.status, 403);
    const bodyB = await b.json();
    assert.match(bodyB.error, /already awaiting review/i);

    approve("reconcileowner", "helloworld", "0.1.0", dataDir);
    reconcileStagedVersions(db, dataDir);

    const rows = db
      .prepare(
        `SELECT v.version, v.status FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'reconcileowner' ORDER BY v.version`,
      )
      .all();
    assert.deepEqual(rows, [{ version: "0.1.0", status: "published" }]);
  });

  test("reconcile finalizes a staging row whose blob became durable", async () => {
    const token = await insertOwner(db, "stagingowner");
    const res = await publish(base, token, buildPublishBody());
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.extension.approved, false);

    db.prepare(
      `UPDATE versions SET status = 'staging', final_status = 'published'
       WHERE owner_id = (SELECT id FROM users WHERE namespace = 'stagingowner')`,
    ).run();
    reconcileStagedVersions(db, dataDir);

    const row = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'stagingowner'`,
      )
      .get();
    assert.equal(row.status, "published");
  });

  test("reconcile deletes a staging row whose blob never became durable", async () => {
    const token = await insertOwner(db, "stagingmissingowner");
    const res = await publish(base, token, buildPublishBody());
    assert.equal(res.status, 201);

    fs.rmSync(blobPath(dataDir, "stagingmissingowner", "helloworld", "0.1.0"));
    db.prepare(
      `UPDATE versions SET status = 'staging'
       WHERE owner_id = (SELECT id FROM users WHERE namespace = 'stagingmissingowner')`,
    ).run();
    reconcileStagedVersions(db, dataDir);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM versions WHERE owner_id = (SELECT id FROM users WHERE namespace='stagingmissingowner')",
      )
      .get().c;
    assert.equal(count, 0);
  });

  test("approval does not miss a version during an in-flight staging->pending transition", async () => {
    const token = await insertOwner(db, "transitionowner");
    const res = await publish(base, token, buildPublishBody());
    assert.equal(res.status, 201);

    assert.ok(
      fs.existsSync(
        blobPath(dataDir, "transitionowner", "helloworld", "0.1.0"),
      ),
      "blob must be durable during the transition window",
    );

    const other = openDatabase(dataDir);
    other.exec("BEGIN IMMEDIATE");
    other
      .prepare(
        `UPDATE versions SET status = 'staging', final_status = 'pending'
         WHERE owner_id = (SELECT id FROM users WHERE namespace = 'transitionowner')`,
      )
      .run();

    const approving = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return approveAsync("transitionowner", "helloworld", "0.1.0", dataDir);
    })();

    other
      .prepare(
        `UPDATE versions SET status = 'pending'
         WHERE owner_id = (SELECT id FROM users WHERE namespace = 'transitionowner')`,
      )
      .run();
    other.exec("COMMIT");
    other.close();

    await approving;

    const rows = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'transitionowner'`,
      )
      .all();
    assert.deepEqual(rows, [{ status: "published" }]);
  });

  test("publish is published, not left pending, when approval completes before reservation", async () => {
    const token = await insertOwner(db, "raceowner");
    db.prepare(
      `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
       VALUES ((SELECT id FROM users WHERE namespace = 'raceowner'),
               'pkga', '0.1.0', 'pending', 'pending', '{}', '/tmp/nonexistent')`,
    ).run();

    const bodyData = buildPublishBody({ id: "pkgb", version: "0.1.0" });
    const encoder = new TextEncoder();
    let finishBody;
    const bodyReady = new Promise((r) => (finishBody = r));
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify(bodyData)));
        bodyReady.then(() => controller.close());
      },
    });

    const publishing = fetch(`${base}/v2/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: stream,
      duplex: "half",
    });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(
      db
        .prepare(
          "SELECT has_published FROM users WHERE namespace = 'raceowner'",
        )
        .get().has_published,
      0,
      "handler must have read the owner before approval completed",
    );
    db.prepare(
      `UPDATE versions SET status = 'published'
       WHERE owner_id = (SELECT id FROM users WHERE namespace = 'raceowner')
         AND package_id = 'pkga'`,
    ).run();
    db.prepare(
      `UPDATE users SET has_published = 1 WHERE namespace = 'raceowner'`,
    ).run();
    finishBody();

    const res = await publishing;
    assert.equal(res.status, 201);
    const body2 = await res.json();
    assert.equal(body2.extension.approved, true);

    const rows = db
      .prepare(
        `SELECT v.status FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'raceowner' AND v.package_id = 'pkgb'`,
      )
      .all();
    assert.deepEqual(rows, [{ status: "published" }]);
  });
});

describe("warp-registry v2 search endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const nameToken = await insertApprovedOwner(db, "nameowner");
    await publish(
      base,
      nameToken,
      buildPublishBody({
        id: "namesearch",
        name: "ZebraWidget",
        description: "a widget for tests",
      }),
    );

    const idToken = await insertApprovedOwner(db, "idowner");
    await publish(
      base,
      idToken,
      buildPublishBody({
        id: "unicornpkg",
        name: "Whatever",
        description: "another package",
      }),
    );

    const ownerToken = await insertApprovedOwner(db, "ownerhunt");
    await publish(
      base,
      ownerToken,
      buildPublishBody({ id: "pkgx", name: "Whatever Two" }),
    );

    const descToken = await insertApprovedOwner(db, "descowner");
    await publish(
      base,
      descToken,
      buildPublishBody({
        id: "pkgy",
        name: "Whatever Three",
        description: "purplebanana",
      }),
    );

    const unicodeToken = await insertApprovedOwner(db, "unicodeowner");
    await publish(
      base,
      unicodeToken,
      buildPublishBody({
        id: "opiesearch",
        name: "\u00C6nigmaWidget",
        description: "unicode name",
      }),
    );

    const multiverToken = await insertApprovedOwner(db, "multiver");
    await publish(
      base,
      multiverToken,
      buildPublishBody({ id: "mypkg", name: "MultiVersion", version: "0.1.0" }),
    );
    await publish(
      base,
      multiverToken,
      buildPublishBody({ id: "mypkg", name: "MultiVersion", version: "0.2.0" }),
    );

    const sharpSToken = await insertApprovedOwner(db, "sharpssowner");
    await publish(
      base,
      sharpSToken,
      buildPublishBody({
        id: "sharppkg",
        name: "Stra\u00DFe",
        description: "German sharp s package",
      }),
    );

    const longSToken = await insertApprovedOwner(db, "longsowner");
    await publish(
      base,
      longSToken,
      buildPublishBody({
        id: "longspkg",
        name: "Ma\u017Fs",
        description: "Latin long s package",
      }),
    );

    const pendingToken = await insertOwner(db, "pendingsearch");
    await publish(
      base,
      pendingToken,
      buildPublishBody({
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

  test("missing or blank query returns the most recently published extensions", async () => {
    for (const url of [
      `${base}/v2/search`,
      `${base}/v2/search?query=`,
      `${base}/v2/search?query=%20%20`,
    ]) {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.results));
      assert.ok(
        body.results.length >= 8,
        "recent published extensions are returned",
      );
      const ids = body.results.map((r) => r.id);
      assert.ok(ids.includes("namesearch"));
      assert.ok(ids.includes("longspkg"));
      assert.ok(!ids.includes("pkgpending"), "pending extensions are excluded");
      assert.ok("nextCursor" in body, "response includes nextCursor");
    }

    const searchRes = await fetch(`${base}/v2/search`);
    assert.equal(searchRes.status, 200);
    const searchIds = (await searchRes.json()).results.map((r) => r.id);

    const extensionsRes = await fetch(`${base}/v2/extensions?limit=50`);
    const extensionsBody = await extensionsRes.json();
    const extensionsIds = extensionsBody.extensions
      .slice(0, searchIds.length)
      .map((p) => p.id);
    assert.deepEqual(
      searchIds,
      extensionsIds,
      "omitted query uses the same ordering as /extensions",
    );
  });

  test("search matches on display name (case-insensitive)", async () => {
    const res = await fetch(`${base}/v2/search?query=zebrawidget`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["namesearch"],
    );
  });

  test("search matches on display name with non-ASCII case folding", async () => {
    const res = await fetch(
      `${base}/v2/search?query=${encodeURIComponent("\u00E6nigmawidget")}`,
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
      `${base}/v2/search?query=${encodeURIComponent("strasse")}`,
    );
    assert.equal(lower.status, 200);
    const lowerBody = await lower.json();
    assert.deepEqual(
      lowerBody.results.map((r) => r.id),
      ["sharppkg"],
      "strasse should match Straße",
    );

    const upper = await fetch(
      `${base}/v2/search?query=${encodeURIComponent("STRASSE")}`,
    );
    assert.equal(upper.status, 200);
    const upperBody = await upper.json();
    assert.deepEqual(
      upperBody.results.map((r) => r.id),
      ["sharppkg"],
      "STRASSE should match Straße",
    );

    const direct = await fetch(
      `${base}/v2/search?query=${encodeURIComponent("Straße")}`,
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
      `${base}/v2/search?query=${encodeURIComponent("mass")}`,
    );
    assert.equal(stdForm.status, 200);
    const stdBody = await stdForm.json();
    assert.deepEqual(
      stdBody.results.map((r) => r.id),
      ["longspkg"],
      "mass should match Ma\u017Fs (long s folds to s)",
    );

    const direct = await fetch(
      `${base}/v2/search?query=${encodeURIComponent("Ma\u017Fs")}`,
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
    const res = await fetch(`${base}/v2/search?query=unicornpkg`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["unicornpkg"],
    );
  });

  test("search matches on owner namespace", async () => {
    const res = await fetch(`${base}/v2/search?query=ownerhunt`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pkgx"],
    );
  });

  test("search matches on description", async () => {
    const res = await fetch(`${base}/v2/search?query=purplebanana`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pkgy"],
    );
  });

  test("search does not return a pending package even if its name matches", async () => {
    const res = await fetch(`${base}/v2/search?query=PineappleExpress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.results, []);
  });

  test("search never returns duplicates for a package with multiple published versions", async () => {
    const res = await fetch(`${base}/v2/search?query=multiversion`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].id, "mypkg");
    assert.equal(body.results[0].latestVersion, "0.2.0");
  });

  test("discovery picks latestVersion by semantic version, not publication order", async () => {
    const token = await insertApprovedOwner(db, "backportowner");
    const publishVersion = async (version) => {
      const res = await publish(
        base,
        token,
        buildPublishBody({ id: "backportpkg", version }),
      );
      assert.equal(res.status, 201);
    };

    await publishVersion("2.0.0");
    await publishVersion("1.5.1");

    const searchRes = await fetch(`${base}/v2/search?query=backportpkg`);
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.results.length, 1);
    assert.equal(
      searchBody.results[0].latestVersion,
      "2.0.0",
      "lower version published later must not supersede the higher version",
    );

    const infoRes = await fetch(`${base}/v2/@backportowner/backportpkg`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.deepEqual(info.versions, ["2.0.0", "1.5.1"]);
  });
});

describe("warp-registry v2 search pagination", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const setCreatedAt = (owner, id, createdAt) => {
      db.prepare(
        `UPDATE versions SET created_at = ?
         WHERE owner_id = (SELECT id FROM users WHERE namespace = ?)
           AND package_id = ?`,
      ).run(createdAt, owner, id);
    };

    for (let i = 1; i <= 12; i += 1) {
      const owner = `spg${String(i).padStart(2, "0")}`;
      const token = await insertApprovedOwner(db, owner);
      const id = `spkg${String(i).padStart(2, "0")}`;
      const res = await publish(
        base,
        token,
        buildPublishBody({ id, name: `Search Pkg ${i}` }),
      );
      assert.equal(res.status, 201);
      setCreatedAt(owner, id, `2024-03-${String(i).padStart(2, "0")} 10:00:00`);
    }
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("omitted query paginates recent results with nextCursor", async () => {
    const page1Res = await fetch(`${base}/v2/search`);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.deepEqual(
      page1.results.map((r) => r.id),
      Array.from(
        { length: 10 },
        (_, i) => `spkg${String(12 - i).padStart(2, "0")}`,
      ),
    );
    assert.ok(page1.nextCursor, "first page must have a nextCursor");

    const page2Res = await fetch(
      `${base}/v2/search?cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.deepEqual(
      page2.results.map((r) => r.id),
      ["spkg02", "spkg01"],
    );
    assert.equal(page2.nextCursor, null, "last page must have null nextCursor");
  });

  test("filtered search paginates with nextCursor too", async () => {
    const page1Res = await fetch(`${base}/v2/search?query=Search%20Pkg`);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.equal(page1.results.length, 10);
    assert.ok(page1.nextCursor, "first page must have a nextCursor");

    const page2Res = await fetch(
      `${base}/v2/search?query=Search%20Pkg&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.equal(page2.results.length, 2);
    assert.equal(page2.nextCursor, null, "last page must have null nextCursor");
  });

  test("invalid cursor returns 400", async () => {
    const notBase64 = await fetch(`${base}/v2/search?cursor=not-a-cursor`);
    assert.equal(notBase64.status, 400);

    const badJson = await fetch(
      `${base}/v2/search?cursor=${encodeURIComponent(Buffer.from("not json").toString("base64"))}`,
    );
    assert.equal(badJson.status, 400);
  });
});

describe("warp-registry v2 semver precedence in discovery routes", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const setCreatedAt = (owner, id, version, createdAt) => {
      db.prepare(
        `UPDATE versions SET created_at = ?
         WHERE owner_id = (SELECT id FROM users WHERE namespace = ?)
           AND package_id = ? AND version = ?`,
      ).run(createdAt, owner, id, version);
    };

    const token = await insertApprovedOwner(db, "preowner");
    const publishVersion = async (pkgId, version) => {
      const res = await publish(
        base,
        token,
        buildPublishBody({ id: pkgId, name: pkgId, version }),
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

  async function latestFromSearchAndExtensions(pkgId) {
    const searchRes = await fetch(
      `${base}/v2/search?query=${encodeURIComponent(pkgId)}`,
    );
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    const searchMatch = searchBody.results.find((r) => r.id === pkgId);

    const extensionsRes = await fetch(`${base}/v2/extensions?limit=50`);
    assert.equal(extensionsRes.status, 200);
    const extensionsBody = await extensionsRes.json();
    const extensionsMatch = extensionsBody.extensions.find(
      (p) => p.id === pkgId,
    );

    return { searchMatch, extensionsMatch };
  }

  async function assertLatest(pkgId, expected) {
    const { searchMatch, extensionsMatch } =
      await latestFromSearchAndExtensions(pkgId);
    assert.ok(searchMatch, `search must return ${pkgId}`);
    assert.equal(searchMatch.latestVersion, expected);
    assert.ok(extensionsMatch, `extensions must return ${pkgId}`);
    assert.equal(extensionsMatch.latestVersion, expected);
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

describe("warp-registry v2 search LIKE escaping", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const underscoreToken = await insertApprovedOwner(db, "usowner");
    await publish(
      base,
      underscoreToken,
      buildPublishBody({ id: "foo_bar", name: "Foo Bar" }),
    );

    const wildcardishToken = await insertApprovedOwner(db, "usowner2");
    await publish(
      base,
      wildcardishToken,
      buildPublishBody({ id: "fooxbar", name: "Foo X Bar" }),
    );

    const percentToken = await insertApprovedOwner(db, "pctowner");
    await publish(
      base,
      percentToken,
      buildPublishBody({ id: "pctpkg1", description: "100%guaranteed" }),
    );

    const wildcardPctToken = await insertApprovedOwner(db, "pctowner2");
    await publish(
      base,
      wildcardPctToken,
      buildPublishBody({ id: "pctpkg2", description: "100x guaranteed" }),
    );
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("underscore in q is matched literally, not as a single-character wildcard", async () => {
    const res = await fetch(
      `${base}/v2/search?query=${encodeURIComponent("foo_bar")}`,
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
      `${base}/v2/search?query=${encodeURIComponent("100%guaranteed")}`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.results.map((r) => r.id),
      ["pctpkg1"],
    );
  });
});

describe("warp-registry v2 extensions pagination", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const setCreatedAt = (owner, id, createdAt) => {
      db.prepare(
        `UPDATE versions SET created_at = ?
         WHERE owner_id = (SELECT id FROM users WHERE namespace = ?)
           AND package_id = ?`,
      ).run(createdAt, owner, id);
    };

    const tokenA = await insertApprovedOwner(db, "paga");
    await publish(
      base,
      tokenA,
      buildPublishBody({ id: "aaa", name: "Package A", version: "1.0.0" }),
    );
    setCreatedAt("paga", "aaa", "2024-01-01 10:00:00");

    const tokenB = await insertApprovedOwner(db, "pagb");
    await publish(
      base,
      tokenB,
      buildPublishBody({ id: "bbb", name: "Package B", version: "1.0.0" }),
    );
    setCreatedAt("pagb", "bbb", "2024-01-02 10:00:00");

    const tokenC = await insertApprovedOwner(db, "pagc");
    await publish(
      base,
      tokenC,
      buildPublishBody({ id: "ccc", name: "Package C", version: "1.0.0" }),
    );
    setCreatedAt("pagc", "ccc", "2024-01-03 10:00:00");
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("returns results in recency order and paginates with nextCursor", async () => {
    const page1Res = await fetch(`${base}/v2/extensions?limit=2`);
    assert.equal(page1Res.status, 200);
    const page1 = await page1Res.json();
    assert.deepEqual(
      page1.extensions.map((p) => p.id),
      ["ccc", "bbb"],
    );
    assert.ok(page1.nextCursor, "first page must have a nextCursor");

    const page2Res = await fetch(
      `${base}/v2/extensions?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    assert.equal(page2Res.status, 200);
    const page2 = await page2Res.json();
    assert.deepEqual(
      page2.extensions.map((p) => p.id),
      ["aaa"],
    );
    assert.equal(page2.nextCursor, null, "last page must have null nextCursor");
  });

  test("response shape includes owner, id, name, description, latestVersion, publishedAt", async () => {
    const res = await fetch(`${base}/v2/extensions?limit=1`);
    const body = await res.json();
    const pkg = body.extensions[0];
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
    assert.equal(pkg.publishedAt, "2024-01-03T10:00:00Z");
  });
});

describe("warp-registry v2 extensions pagination: limit and cursor validation", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const token = await insertApprovedOwner(db, "bulkowner");
    for (let i = 0; i < 55; i++) {
      const id = `bulk${String(i).padStart(2, "0")}`;
      await publish(base, token, buildPublishBody({ id, name: `Bulk ${i}` }));
    }
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("limit above 50 is clamped to 50", async () => {
    const res = await fetch(`${base}/v2/extensions?limit=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.extensions.length, 50);
    assert.ok(body.nextCursor, "a nextCursor should remain after clamping");
  });

  test("non-positive or non-integer limit returns 400", async () => {
    const zero = await fetch(`${base}/v2/extensions?limit=0`);
    assert.equal(zero.status, 400);

    const negative = await fetch(`${base}/v2/extensions?limit=-5`);
    assert.equal(negative.status, 400);

    const nonInteger = await fetch(`${base}/v2/extensions?limit=2.5`);
    assert.equal(nonInteger.status, 400);

    const notANumber = await fetch(`${base}/v2/extensions?limit=abc`);
    assert.equal(notANumber.status, 400);
  });

  test("invalid cursor returns 400", async () => {
    const notBase64 = await fetch(`${base}/v2/extensions?cursor=not-a-cursor`);
    assert.equal(notBase64.status, 400);

    const badJson = await fetch(
      `${base}/v2/extensions?cursor=${encodeURIComponent(Buffer.from("not json").toString("base64"))}`,
    );
    assert.equal(badJson.status, 400);
  });
});

describe("warp-registry v2 stats endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());

    const token1 = await insertApprovedOwner(db, "statowner1");
    await publish(
      base,
      token1,
      buildPublishBody({ id: "statpkg", version: "0.1.0" }),
    );
    await publish(
      base,
      token1,
      buildPublishBody({ id: "statpkg", version: "0.2.0" }),
    );

    const token2 = await insertApprovedOwner(db, "statowner2");
    await publish(
      base,
      token2,
      buildPublishBody({ id: "otherpkg", version: "1.0.0" }),
    );

    const pendingToken = await insertOwner(db, "statpendingowner");
    await publish(
      base,
      pendingToken,
      buildPublishBody({ id: "pendingpkg", version: "0.1.0" }),
    );
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("stats reflect published pairs, pending rows, and distinct authors", async () => {
    const res = await fetch(`${base}/v2/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.published, 2);
    assert.equal(body.pending, 1);
    assert.equal(body.authors, 2);
  });
});

describe("warp-registry v2 second pending publish guard", () => {
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
    const token = await insertOwner(db, "pendingguard");

    const aRes = await publish(
      base,
      token,
      buildPublishBody({ id: "pkga", version: "0.1.0" }),
    );
    assert.equal(aRes.status, 201);
    assert.equal((await aRes.json()).extension.approved, false);

    const bRes = await publish(
      base,
      token,
      buildPublishBody({ id: "pkgb", version: "0.1.0" }),
    );
    assert.equal(bRes.status, 403);
    const bBody = await bRes.json();
    assert.match(bBody.error, /already awaiting review/i);

    const bRows = db
      .prepare(
        `SELECT v.* FROM versions v JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'pendingguard' AND v.package_id = 'pkgb'`,
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

    const bRetry = await publish(
      base,
      token,
      buildPublishBody({ id: "pkgb", version: "0.1.0" }),
    );
    assert.equal(bRetry.status, 201);
    const bRetryBody = await bRetry.json();
    assert.equal(bRetryBody.extension.approved, true);
  });
});

describe("warp-registry v2 users endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("GET /v2/users returns paginated user list", async () => {
    await insertOwner(db, "user1");
    await insertOwner(db, "user2");
    const res = await fetch(`${base}/v2/users`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.users));
    assert.ok(body.users.length >= 2);
    assert.ok(body.users[0].namespace);
    assert.equal(body.nextCursor, null);
  });

  test("GET /v2/users paginates with a cursor", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertOwner(db, `cursuser${i}`);
    }

    const seen = [];
    let cursor = "";
    let page;
    do {
      const url = cursor
        ? `${base}/v2/users?limit=2&cursor=${encodeURIComponent(cursor)}`
        : `${base}/v2/users?limit=2`;
      const res = await fetch(url);
      assert.equal(res.status, 200);
      page = await res.json();
      assert.ok(Array.isArray(page.users));
      assert.ok(page.users.length <= 2);
      for (const u of page.users) seen.push(u.namespace);
      cursor = page.nextCursor;
    } while (cursor);

    const unique = new Set(seen);
    assert.equal(
      unique.size,
      seen.length,
      "no user appears twice across pages",
    );
    assert.equal(seen.includes("user1"), true);
    assert.equal(seen.includes("cursuser0"), true);
    assert.equal(seen.includes("cursuser4"), true);
  });

  test("GET /v2/users/:namespace returns a single user", async () => {
    await insertOwner(db, "singleuser");
    const res = await fetch(`${base}/v2/users/singleuser`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.namespace, "singleuser");
    assert.ok(Array.isArray(body.extensions));
  });

  test("GET /v2/users/:namespace returns 404 for unknown user", async () => {
    const res = await fetch(`${base}/v2/users/nonexistent`);
    assert.equal(res.status, 404);
  });
});

describe("warp-registry v2 user update and delete", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("user can update own displayName", async () => {
    const { token } = await signup(
      base,
      "updateuser",
      "password123",
      "Old Name",
    );
    const res = await fetch(`${base}/v2/users/updateuser`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ displayName: "New Name" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.displayName, "New Name");
  });

  test("user cannot update another user", async () => {
    const { token } = await signup(base, "usera", "password123");
    await insertOwner(db, "userb");
    const res = await fetch(`${base}/v2/users/userb`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ displayName: "Hacked" }),
    });
    assert.equal(res.status, 403);
  });

  test("admin can update any user", async () => {
    const adminToken = await insertAdmin(db, "adminuser");
    await insertOwner(db, "targetuser");
    const res = await fetch(`${base}/v2/users/targetuser`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ displayName: "Admin Updated" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.displayName, "Admin Updated");
  });

  test("user can delete own account", async () => {
    const { token } = await signup(base, "selfdelete", "password123");
    const res = await fetch(`${base}/v2/users/selfdelete`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const check = await fetch(`${base}/v2/users/selfdelete`);
    assert.equal(check.status, 404);
  });

  test("unauthenticated PATCH returns 401", async () => {
    const res = await fetch(`${base}/v2/users/anyone`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "X" }),
    });
    assert.equal(res.status, 401);
  });
});

describe("warp-registry v2 extension update and delete", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("owner can update own extension meta", async () => {
    const token = await insertApprovedOwner(db, "extowner");
    await publish(base, token, buildPublishBody({ id: "myext" }));

    const res = await fetch(`${base}/v2/@extowner/myext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        meta: {
          class: "MyExt",
          name: "Updated Name",
          id: "myext",
          license: "MIT",
          authors: ["test"],
          description: "updated",
          version: "0.1.0",
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.name, "Updated Name");
  });

  test("PATCH with a blob whose extracted id does not match is rejected", async () => {
    const token = await insertApprovedOwner(db, "patchidowner");
    await publish(base, token, buildPublishBody({ id: "patchidext" }));

    const res = await fetch(`${base}/v2/@patchidowner/patchidext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        extensionBlob: buildPublishBody({ id: "differentid" }).extensionBlob,
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /meta.id must match/i);
  });

  test("PATCH with a blob with a non-semver version is rejected", async () => {
    const token = await insertApprovedOwner(db, "patchverowner");
    await publish(base, token, buildPublishBody({ id: "patchverext" }));

    const body = buildPublishBody({ id: "patchverext" });
    body.extensionBlob = body.extensionBlob.replace(
      'version: "0.1.0"',
      'version: "not-a-version"',
    );
    const res = await fetch(`${base}/v2/@patchverowner/patchverext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ extensionBlob: body.extensionBlob }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /valid semver/i);
  });

  test("PATCH with a blob can add a new version", async () => {
    const token = await insertApprovedOwner(db, "patchnewver");
    await publish(base, token, buildPublishBody({ id: "patchnewext" }));

    const res = await fetch(`${base}/v2/@patchnewver/patchnewext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        extensionBlob: buildPublishBody({
          id: "patchnewext",
          version: "0.2.0",
        }).extensionBlob,
      }),
    });
    assert.equal(res.status, 200);

    const info = await fetch(`${base}/v2/@patchnewver/patchnewext`);
    assert.equal(info.status, 200);
    const infoBody = await info.json();
    assert.ok(infoBody.versions.includes("0.2.0"));
  });

  test("PATCH persists the blob's extracted meta, not a mismatched request meta", async () => {
    const token = await insertApprovedOwner(db, "patchmaowner");
    await publish(base, token, buildPublishBody({ id: "patchmaext" }));

    const blob = buildPublishBody({
      id: "patchmaext",
      version: "0.3.0",
      name: "Blob-Derived Name",
    }).extensionBlob;

    const res = await fetch(`${base}/v2/@patchmaowner/patchmaext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        meta: {
          class: "X",
          name: "Client-Supplied Name",
          id: "patchmaext",
          license: "MIT",
          authors: [],
          description: "x",
          version: "0.3.0",
        },
        extensionBlob: blob,
      }),
    });
    assert.equal(res.status, 200);

    const row = db
      .prepare(
        `SELECT v.meta_json FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = 'patchmaowner' AND v.package_id = 'patchmaext'
           AND v.version = '0.3.0'`,
      )
      .get();
    assert.ok(row, "the blob version must be persisted");
    const storedMeta = JSON.parse(row.meta_json);
    assert.equal(
      storedMeta.name,
      "Blob-Derived Name",
      "metadata must come from the blob, not the client-supplied meta",
    );
  });

  test("non-owner cannot update extension", async () => {
    const ownerToken = await insertApprovedOwner(db, "extowner2");
    await publish(base, ownerToken, buildPublishBody({ id: "secureext" }));

    const otherToken = await insertApprovedOwner(db, "otherperson");
    const res = await fetch(`${base}/v2/@extowner2/secureext`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${otherToken}`,
      },
      body: JSON.stringify({
        meta: {
          class: "X",
          name: "Hijacked",
          id: "secureext",
          license: "MIT",
          authors: [],
          description: "x",
          version: "0.1.0",
        },
      }),
    });
    assert.equal(res.status, 403);
  });

  test("owner can delete own extension", async () => {
    const token = await insertApprovedOwner(db, "delowner");
    await publish(base, token, buildPublishBody({ id: "delme" }));

    const res = await fetch(`${base}/v2/@delowner/delme`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const check = await fetch(`${base}/v2/@delowner/delme`);
    assert.equal(check.status, 404);
  });
});

describe("warp-registry v2 approve endpoint", () => {
  let server;
  let db;
  let base;

  before(async () => {
    ({ server, db, base } = await startServer());
  });

  after(async () => {
    await closeServer(server);
    db.close();
  });

  test("admin can approve a pending extension", async () => {
    const adminToken = await insertAdmin(db, "adminapprove");
    const userToken = await insertOwner(db, "normaluser");

    await publish(
      base,
      userToken,
      buildPublishBody({ id: "pendext", version: "0.1.0" }),
    );

    const res = await fetch(`${base}/v2/@normaluser/pendext/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);

    const infoRes = await fetch(`${base}/v2/@normaluser/pendext`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.deepEqual(info.versions, ["0.1.0"]);
  });

  test("non-admin cannot approve", async () => {
    const userToken = await insertOwner(db, "nonadmin");
    const normalToken = await insertApprovedOwner(db, "normalapprove");
    await publish(
      base,
      normalToken,
      buildPublishBody({ id: "unapproved", version: "0.1.0" }),
    );

    const res = await fetch(`${base}/v2/@normalapprove/unapproved/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.status, 403);
  });

  test("approve returns 404 for non-existent extension", async () => {
    const adminToken = await insertAdmin(db, "adminnoexist");
    const res = await fetch(`${base}/v2/@nobody/noext/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 404);
  });
});
