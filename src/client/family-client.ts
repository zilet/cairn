// @ts-check
// Me Family renderers: pure HTML for the people the coach plans around.

type FamilyColor = { v: string; l: string };

type FamilyRow = {
  id?: unknown;
  name?: unknown;
  relationship?: unknown;
  birthdate?: unknown;
  color?: unknown;
  notes?: unknown;
  allergies?: unknown;
  dietary_restrictions?: unknown;
};

(() => {
// A small Atelier swatch palette drawn from the design tokens. Each entry is the
// stored color value (the token's hex) plus a display label.
const FAMILY_COLORS: readonly FamilyColor[] = [
  { v: "#b4552d", l: "Terracotta" },
  { v: "#6e7f5c", l: "Sage" },
  { v: "#c9a86a", l: "Gold" },
  { v: "#8e4f6d", l: "Plum" },
  { v: "#57503f", l: "Ink" },
  { v: "#7d8f5e", l: "Olive" },
];
const FAMILY_DEFAULT_COLOR = FAMILY_COLORS[0].v;

function familyColor(color: unknown): string {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : FAMILY_DEFAULT_COLOR;
}

// Plain-language age from a free-text YYYY-MM-DD birthdate. Babies read in months;
// everyone else in years. Null/garbage -> "" (no age line shown).
function ageFromBirthdate(birthdate: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthdate || ""));
  if (!match) return "";
  const born = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(born.getTime())) return "";
  const now = new Date();
  let months = (now.getFullYear() - born.getFullYear()) * 12 + (now.getMonth() - born.getMonth());
  if (now.getDate() < born.getDate()) months--;
  if (months < 0) return "";
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr`;
}

function familyInitials(name: unknown): string {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function familyCardInner(row: FamilyRow): string {
  const color = familyColor(row.color);
  const age = ageFromBirthdate(row.birthdate);
  const meta = [];
  if (row.relationship) meta.push(escHtml(row.relationship));
  if (age) meta.push(escHtml(age));
  const restrictions = [
    row.allergies ? `avoids ${escHtml(row.allergies)}` : "",
    row.dietary_restrictions ? escHtml(row.dietary_restrictions) : "",
  ].filter(Boolean).join(" · ");
  return `<div class="fam-head">
      <span class="fam-mono" style="--fam:${escAttr(color)}">${escHtml(familyInitials(row.name))}</span>
      <div class="fam-id">
        <span class="fam-name">${escHtml(row.name || "Someone")}</span>
        ${meta.length ? `<span class="fam-meta">${meta.join(" · ")}</span>` : ""}
      </div>
    </div>
    ${row.notes ? `<div class="sess-line fam-notes">${escHtml(row.notes)}</div>` : ""}
    ${restrictions ? `<div class="sess-line fam-notes" style="color:var(--muted)">${restrictions}</div>` : ""}
    <div class="hdoc-ctl">
      <button class="iconbtn" data-fedit="${escAttr(row.id)}" title="edit">✎</button>
      <button class="iconbtn fam-del" data-fdel="${escAttr(row.id)}" title="delete">×</button>
    </div>`;
}

function familyCardHtml(row: FamilyRow, index?: number): string {
  const reveal = typeof index === "number";
  return `<div class="sess fam-card${reveal ? " reveal" : ""}" data-fam="${escAttr(row.id)}"${reveal ? ` style="${stagger(index)}"` : ""}>${familyCardInner(row)}</div>`;
}

function familySwatches(selected: unknown): string {
  const active = familyColor(selected);
  return `<div class="fam-swatches" role="radiogroup" aria-label="Colour">
    ${FAMILY_COLORS.map((color) => `<button type="button" class="fam-swatch${color.v === active ? " fam-swatch-on" : ""}" data-color="${escAttr(color.v)}" style="--fam:${escAttr(color.v)}" title="${escAttr(color.l)}" aria-label="${escAttr(color.l)}"></button>`).join("")}
  </div>`;
}

const CAIRN_FAMILY = {
  FAMILY_COLORS,
  FAMILY_DEFAULT_COLOR,
  familyColor,
  ageFromBirthdate,
  familyInitials,
  familyCardInner,
  familyCardHtml,
  familySwatches,
};

Object.assign(globalThis, { CairnFamily: CAIRN_FAMILY });

if (typeof window !== "undefined") {
  window.CairnFamily = CAIRN_FAMILY;
}
})();
