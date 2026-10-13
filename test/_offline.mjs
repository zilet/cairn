// Side-effect import: a test process the runner did not start still gets a throwaway
// DATA_DIR/DB_PATH and an offline AGENTS_CONFIG (only where unset; see ./_env.mjs).
// Must be evaluated before anything loads dist/db.js or dist/agents.js.
import { applyOfflineDefaults } from "./_env.mjs";

applyOfflineDefaults();
