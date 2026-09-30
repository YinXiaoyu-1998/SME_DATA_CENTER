import { pathToFileURL } from "node:url";
import { parsePdfAcceptanceArgs } from "./pdf-acceptance-support.js";
import { runPdfAcceptanceRuntime } from "./pdf-acceptance-runtime.js";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parsePdfAcceptanceArgs(process.argv.slice(2));
  if (!args) throw new Error("PDF acceptance requires --profile=pdf; no legacy fallback.");
  await runPdfAcceptanceRuntime(args);
}
