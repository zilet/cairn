// Undoing a skip seats the card by ITEM position (the card after it, else the card before it), never
// beside a pair caption: a regroup may remove that caption, leaving the card stranded at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, createHost, loadClientModule } from "./_dom.mjs";

function surface() {
  const win = loadClientModule(["html-utils", "today-session-skip-place-client"]);
  const root = createHost(win.document);
  root.innerHTML = [
    '<div class="ex" data-card="a"></div>',
    '<div class="ex-group-caption" id="cap1"></div>',
    '<div class="ex" data-card="b"></div>',
    '<div class="ex" data-card="c"></div>',
    '<div class="ex-group-caption" id="cap2"></div>',
    '<div class="ex" data-card="d"></div>',
    '<div class="addex"></div>',
  ].join("");
  return { S: win.CairnTodaySkipPlace, root };
}
const order = (root) => [...root.querySelectorAll(".ex[data-card]")].map((el) => el.dataset.card).join("");

test("the place of a skipped card is the cards around it, not a caption", () => {
  const { S, root } = surface();
  const b = root.querySelector('[data-card="b"]');
  const place = S.cardPlace([b], root);
  assert.equal(place.prev.dataset.card, "a");
  assert.equal(place.next.dataset.card, "c");
});

test("a card is seated back in item order even after the caption beside it is gone", () => {
  const { S, root } = surface();
  const c = root.querySelector('[data-card="c"]');
  const place = S.cardPlace([c], root);
  c.remove();
  root.querySelector("#cap2").remove(); // a regroup dropped the caption the card used to precede
  assert.equal(S.seatCards([c], place, root), true);
  assert.equal(order(root), "abcd");
});

test("with the following card gone too it seats after the previous card, else at the end", () => {
  const { S, root } = surface();
  const d = root.querySelector('[data-card="d"]');
  const place = S.cardPlace([d], root);
  d.remove();
  assert.equal(S.seatCards([d], place, root), true);
  assert.equal(order(root), "abcd", "after c, not stranded behind the add-exercise row");
  const lone = surface();
  const only = lone.root.querySelector('[data-card="a"]');
  const p = lone.S.cardPlace([only], lone.root);
  only.remove();
  for (const el of [...lone.root.querySelectorAll(".ex")]) el.remove();
  assert.equal(lone.S.seatCards([only], p, lone.root), true);
  const kids = [...lone.root.children];
  assert.equal(kids[kids.indexOf(lone.root.querySelector(".addex")) - 1], only);
});
