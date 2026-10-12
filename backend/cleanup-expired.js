import { readRuntimeConfig } from "./src/config.js";
import { cleanupExpiredClips } from "./src/storage.js";

try {
  const config = readRuntimeConfig();
  const deleted = await cleanupExpiredClips(config);
  console.log(`Retention cleanup complete. Deleted ${deleted} expired clip(s).`);
} catch (error) {
  console.error(`Retention cleanup failed: ${error.message}`);
  process.exitCode = 1;
}
