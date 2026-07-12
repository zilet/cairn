import assert from "node:assert/strict";
import { test } from "node:test";
import { db } from "../dist/db.js";
import { getProfile, setProfile } from "../dist/repo.js";
import { seedIfEmpty } from "../dist/seed.js";

test("CAIRN_BLANK_PROFILE creates only a neutral exercise catalog and never erases established data", async () => {
  const previous = process.env.CAIRN_BLANK_PROFILE;
  process.env.CAIRN_BLANK_PROFILE = "1";
  try {
    assert.equal(await seedIfEmpty(), true);

    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    assert.ok(count("exercises") > 0);
    assert.equal(count("plan_days"), 0);
    assert.equal(count("plan_items"), 0);
    assert.equal(count("sessions"), 0);
    assert.equal(count("logged_sets"), 0);
    assert.equal(count("body_measurements"), 0);
    assert.equal(count("bodyweight_log"), 0);
    assert.equal(count("profile"), 0);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM exercises WHERE constraint_note IS NOT NULL").get().n), 0);

    // Even in the unusual case where an established user deleted every plan and
    // exercise, a later blank-mode seed may restore the neutral catalog but must
    // not touch their profile or history.
    setProfile({ about_me: "Getting started" });
    assert.equal(getProfile().sex, null, "partial blank-profile writes must not silently default sex to male");
    setProfile({ name: "Partner", sex: "female" });
    db.prepare("INSERT INTO sessions (date, notes) VALUES ('2026-07-12', 'real session')").run();
    db.exec("DELETE FROM exercises");
    assert.equal(await seedIfEmpty(), true);
    assert.deepEqual({ ...db.prepare("SELECT name, sex FROM profile WHERE id = 1").get() }, { name: "Partner", sex: "female" });
    assert.equal(count("sessions"), 1);
    assert.equal(count("plan_days"), 0);
    assert.ok(count("exercises") > 0);
  } finally {
    if (previous === undefined) delete process.env.CAIRN_BLANK_PROFILE;
    else process.env.CAIRN_BLANK_PROFILE = previous;
  }
});
