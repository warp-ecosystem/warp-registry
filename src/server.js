import "dotenv/config";
import path from "node:path";
import { openDatabase } from "./db.js";
import { createApp, reconcileStagedVersions } from "./routes.js";
import { success, warn } from "./logger.js";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DEFAULT_SHUTDOWN_TIMEOUT = 5000;
const MAX_SHUTDOWN_TIMEOUT = 9000;
/**
 * Determines the shutdown timeout from the environment configuration.
 * @return {number} The configured timeout in milliseconds when valid; otherwise, the default shutdown timeout.
 */
function resolveShutdownTimeout() {
  const value = Number(
    process.env.SHUTDOWN_TIMEOUT || DEFAULT_SHUTDOWN_TIMEOUT,
  );
  if (!Number.isFinite(value) || value < 1 || value > MAX_SHUTDOWN_TIMEOUT) {
    return DEFAULT_SHUTDOWN_TIMEOUT;
  }
  return value;
}
const SHUTDOWN_TIMEOUT = resolveShutdownTimeout();

const config = {
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

const db = openDatabase(DATA_DIR);
reconcileStagedVersions(db, DATA_DIR);
const app = createApp({ db, dataDir: DATA_DIR, config });

const server = app.listen(PORT, () => {
  success(`Warp Registry listening on http://localhost:${PORT}`);
});

let shuttingDown = false;

/**
 * Gracefully shuts down the server and database in response to a process signal.
 * @param {string} signal - The signal that initiated shutdown.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  warn(`Received ${signal}, shutting down gracefully…`);

  const forceExit = setTimeout(() => {
    warn("Shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  forceExit.unref();

  server.close(() => {
    db.close();
    success("Shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
