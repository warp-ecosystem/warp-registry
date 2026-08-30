import "dotenv/config";
import path from "node:path";
import { openDatabase } from "./db.js";
import { createApp, reconcileStagedVersions } from "./routes.js";
import { success } from "./logger.js";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

const config = {
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
};

const db = openDatabase(DATA_DIR);
reconcileStagedVersions(db, DATA_DIR);
const app = createApp({ db, dataDir: DATA_DIR, config });

app.listen(PORT, () => {
  success(`Warp Registry listening on http://localhost:${PORT}`);
});
