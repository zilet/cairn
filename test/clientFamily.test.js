import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadFamilyClient() {
  const context = {
    Date,
    Number,
    Object,
    String,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/family-client.js"), "utf8"), context);
  return context.CairnFamily;
}

test("family helper normalizes color, initials, and age", () => {
  const family = loadFamilyClient();

  assert.equal(family.familyColor("#abc"), "#abc");
  assert.equal(family.familyColor("not-a-color"), family.FAMILY_DEFAULT_COLOR);
  assert.equal(family.familyInitials("Mara Zikic"), "MZ");
  assert.equal(family.familyInitials("Mara"), "MA");
  assert.equal(family.familyInitials(""), "?");
  assert.match(family.ageFromBirthdate("2000-01-01"), /^\d+ yr$/);
  assert.equal(family.ageFromBirthdate("bad"), "");
  assert.equal(family.FAMILY_COLORS.length, 6);
});

test("family card renderer escapes user content and attributes", () => {
  const family = loadFamilyClient();
  const html = family.familyCardHtml(
    {
      id: '7" onclick="bad',
      name: "Mara <kid>",
      relationship: "daughter <oldest>",
      birthdate: "2018-02-01",
      color: "javascript:red",
      notes: "soccer <Tuesdays>",
      allergies: "peanuts <severe>",
      dietary_restrictions: "vegetarian <mostly>",
    },
    3,
  );

  assert.match(html, /data-fam="7&quot; onclick=&quot;bad"/);
  assert.match(html, /Mara &lt;kid&gt;/);
  assert.match(html, /daughter &lt;oldest&gt;/);
  assert.match(html, /soccer &lt;Tuesdays&gt;/);
  assert.match(html, /avoids peanuts &lt;severe&gt; · vegetarian &lt;mostly&gt;/);
  assert.match(html, /--i:3/);
  assert.doesNotMatch(html, /<kid>|<oldest>|<Tuesdays>|onclick="bad|javascript:red/);
});

test("family swatches mark one selected color safely", () => {
  const family = loadFamilyClient();
  const html = family.familySwatches("#6e7f5c");

  assert.match(html, /role="radiogroup"/);
  assert.match(html, /data-color="#6e7f5c"/);
  assert.equal((html.match(/fam-swatch-on/g) || []).length, 1);
  assert.match(html, /aria-label="Sage"/);
});
