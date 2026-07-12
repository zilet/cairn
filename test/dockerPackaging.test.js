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
  const compose = read("docker-compose.yml");
  const releaseCompose = read("deploy/docker-compose.release.yml");

  assert.match(dockerignore, /^\*\*$/m);
  assert.match(dockerignore, /!public\/js\/10-boot\.js/);
  assert.match(dockerignore, /!seed-art\/\*\*/);
  assert.doesNotMatch(dockerignore, /!README\.md|!CLAUDE\.md|!AGENTS\.md|!docs\/|!test\/|!media\//);

  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS production-deps/);
  assert.match(dockerfile, /COPY --from=production-deps \/app\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /COPY seed-art \.\/seed-art/);
  assert.match(dockerfile, /COPY scripts\/install-agent-cli\.mjs \/usr\/local\/lib\/cairn/);
  assert.doesNotMatch(dockerfile, /ARG INSTALL_CLAUDE|ARG INSTALL_CODEX|ARG INSTALL_ANTIGRAVITY|ARG INSTALL_GROK/);
  assert.match(dockerfile, /VOLUME \["\/data", "\/home\/app", "\/home\/app\/\.cairn-tools"\]/);
  for (const body of [compose, releaseCompose]) {
    assert.match(body, /cairn-tools:\/home\/app\/\.cairn-tools/);
    assert.match(body, /^\s{2}cairn-tools:\s*$/m);
    assert.match(body, /container_name: \$\{CAIRN_CONTAINER_NAME:-cairn\}/);
    assert.match(body, /\$\{CAIRN_HOST_PORT:-8787\}:8787/);
    assert.match(body, /CAIRN_BLANK_PROFILE=\$\{CAIRN_BLANK_PROFILE:-0\}/);
  }
  assert.match(compose, /\$\{CAIRN_BIND_HOST:-0\.0\.0\.0\}/);
  assert.match(releaseCompose, /\$\{CAIRN_BIND_HOST:-127\.0\.0\.1\}/);
  assert.match(releaseCompose, /CAIRN_REQUIRE_AUTH=\$\{CAIRN_REQUIRE_AUTH:-0\}/);
  assert.match(releaseCompose, /CAIRN_SETTINGS_SECRET_KEY=\$\{CAIRN_SETTINGS_SECRET_KEY:-\}/);
  assert.doesNotMatch(dockerfile, /COPY public \.\/public/);

  const runtimeDockerfile = dockerfile.split("# ---- runtime ----")[1];
  assert.ok(runtimeDockerfile, "runtime stage must exist");
  assert.doesNotMatch(runtimeDockerfile, /COPY package\*\.json/);
  assert.doesNotMatch(runtimeDockerfile, /npm ci --omit=dev/);
});
