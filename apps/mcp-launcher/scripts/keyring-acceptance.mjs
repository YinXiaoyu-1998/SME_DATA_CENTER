import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";

const installPrefix = process.argv[2];
if (!installPrefix) throw new Error("Installed launcher prefix is required.");

const requireFromInstall = createRequire(path.join(path.resolve(installPrefix), "package.json"));
const { AsyncEntry } = requireFromInstall("@napi-rs/keyring");
const id = randomUUID();
const entry = new AsyncEntry(
  `com.smedatacenter.enterprise-hub.launcher.acceptance.${id}`,
  `acceptance-${id}`
);
const credential = randomUUID() + randomUUID();
let writeCompleted = false;

try {
  await entry.setPassword(credential);
  writeCompleted = true;
  if ((await entry.getPassword()) !== credential) {
    throw new Error("Native secure-store read did not match the randomized acceptance value.");
  }
  if (!(await entry.deleteCredential())) {
    throw new Error("Native secure-store delete did not confirm cleanup.");
  }
  writeCompleted = false;
  if ((await entry.getPassword()) != null) {
    throw new Error("Native secure-store record remained after cleanup.");
  }
  process.stdout.write('{"keyringWriteReadDelete":true}\n');
} finally {
  if (writeCompleted) await entry.deleteCredential().catch(() => undefined);
}
