import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Docker context and runtime image stay execution-only", () => {
  const dockerignore = read(".dockerignore");
  const dockerfile = read("Dockerfile");

  assert.match(dockerignore, /^\*\*$/m);
  assert.match(dockerignore, /!public\/js\/10-boot\.js/);
  assert.match(dockerignore, /!seed-art\/\*\*/);
  assert.doesNotMatch(
    dockerignore,
    /!README\.md|!CLAUDE\.md|!AGENTS\.md|!docs\/|!test\/|!media\//,
  );

  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS production-deps/);
  assert.match(dockerfile, /COPY --from=production-deps \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /COPY seed-art \.\/seed-art/);
  assert.doesNotMatch(dockerfile, /COPY public \.\/public/);

  const runtimeDockerfile = dockerfile.split("# ---- runtime ----")[1];
  assert.ok(runtimeDockerfile, "runtime stage must exist");
  assert.doesNotMatch(runtimeDockerfile, /COPY package\*\.json/);
  assert.doesNotMatch(runtimeDockerfile, /npm ci --omit=dev/);
});
