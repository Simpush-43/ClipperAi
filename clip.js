import { runPipeline } from "./backend/src/pipeline.js";

runPipeline(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
