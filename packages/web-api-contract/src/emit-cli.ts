import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebApiContract, serializeWebApiContract } from "./emit.js";
import { WEB_API_ROUTES, validateWebApiRoutes } from "./registry.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(packageRoot, "contract.json");

validateWebApiRoutes({ routes: WEB_API_ROUTES });
await writeFile(target, serializeWebApiContract(buildWebApiContract()), "utf8");
process.stdout.write(`${target}\n`);
