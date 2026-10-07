// The built modules that used to be one public/js/api-client.js, in their
// bundle-01 load order: the token sheet, the api() core, then the offline outbox
// (queue, live runtime + lease, replay reading, workout mutations, drain + public
// API, bar + review). clientApiClientSplit.test.js holds this list to BUNDLES.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const API_CLIENT_MODULES = [
  "token-sheet",
  "api-cache",
  "api-reach",
  "api-auth",
  "api-core",
  "api-signals",
  "outbox-queue",
  "outbox-runtime",
  "outbox-replay",
  "outbox-session",
  "outbox",
  "outbox-ui",
];

/** Runs every api/outbox module, in order, in one vm context (contextified on first use). */
export function runApiClientModules(context) {
  for (const name of API_CLIENT_MODULES) {
    vm.runInNewContext(readFileSync(join(root, `public/js/${name}.js`), "utf8"), context, {
      filename: `public/js/${name}.js`,
    });
  }
  return context;
}
