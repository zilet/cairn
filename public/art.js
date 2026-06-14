/*
 * Cairn Atelier illustration library — window.CairnArt
 * ----------------------------------------------------
 * Hand-crafted inline SVG plates in the "Atelier" design language (docs/DESIGN.md):
 * studio food photography reduced to minimal flat-volume vector, and duotone ink
 * line-art exercise figures. Every plate sits on a soft cream circle (#efe8db)
 * with an elliptical studio shadow under the subject.
 *
 * Plain script, no module system — loaded via <script src="/art.js"> BEFORE app.js.
 *
 * API:
 *   CairnArt.food(text)                 -> SVG string (keyword-mapped, generic plate fallback)
 *   CairnArt.exercise(name, muscleGroup)-> SVG string (movement pattern, muscle fallback, kettlebell fallback)
 *   CairnArt.activity(type)             -> SVG string (run/ride/swim/walk/hike/row/yoga, pulse fallback)
 *
 * Hard guarantees:
 *   - viewBox "0 0 96 96", no width/height, aria-hidden="true" on every SVG.
 *   - Caller text is NEVER interpolated into markup — keyword matching only,
 *     every returned string is a constant built once at load time.
 *   - Deterministic; null/undefined/garbage input returns the fallback art.
 */
"use strict";
(function (root) {
  // =========================================================================
  // Palette (mirrors docs/DESIGN.md :root + food-natural hues)
  // =========================================================================
  var INK = "#211d17";       // ink strokes, line-art figures
  var ACC = "#b4552d";       // terracotta accent (implements, straws, mats)
  var ACC_DEEP = "#93421f";  // terracotta shade
  var CREAM = "#efe8db";     // backdrop circle
  var CARD = "#fffdf8";      // porcelain / plate white
  var SHDW = "#e0d4bd";      // studio shadow on the cream circle
  var WELL = "#f3ecdd";      // plate well
  var SAGE = "#7d8f5e";      // greens
  var SAGE_LT = "#93a571";   // lighter greens
  var SALMON = "#e8836a";    // fish
  var BERRY = "#8e4f6d";     // berries
  var BERRY_DK = "#6d3c54";
  var YOLK = "#e8b54a";
  var STEAM = "#cfc4ad";
  var WATER = "#7e9b94";     // the one cool note allowed: natural water
  var WATER_LT = "#a5bcb4";
  var MOTION = "#c3b69a";    // faint motion / ground lines

  // =========================================================================
  // Shared scaffolding helpers (all output is assembled ONCE at load time)
  // =========================================================================
  function svgWrap(inner) {
    return '<svg viewBox="0 0 96 96" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="48" cy="48" r="44" fill="' + CREAM + '"/>' +
      inner +
      "</svg>";
  }
  // Elliptical studio shadow under the subject.
  function sh(cy, rx, ry) {
    return '<ellipse cx="48" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + SHDW + '"/>';
  }
  // Ink limb / outline stroke (the figure language: 2.5px, round caps + joins).
  function ln(d) {
    return '<path d="' + d + '" fill="none" stroke="' + INK +
      '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  // Generic stroke with custom color/width.
  function thin(d, c, w) {
    return '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + w +
      '" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  function dot(x, y, r, c) {
    return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + c + '"/>';
  }
  function el(x, y, rx, ry, c, rot) {
    return '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" fill="' + c + '"' +
      (rot ? ' transform="rotate(' + rot + " " + x + " " + y + ')"' : "") + "/>";
  }
  // Figure head: cream-filled ink circle.
  function headAt(x, y) {
    return '<circle cx="' + x + '" cy="' + y + '" r="4.3" fill="' + CREAM +
      '" stroke="' + INK + '" stroke-width="2.5"/>';
  }
  // Barbell plate seen end-on: terracotta disc + cream hub.
  function plateEnd(x, y, r) {
    return dot(x, y, r, ACC) + dot(x, y, r * 0.27, CREAM);
  }
  // Dumbbell head.
  function db(x, y, r) {
    return dot(x, y, r, ACC);
  }
  // Small kettlebell (handle arc + terracotta body).
  function kb(x, y) {
    return thin("M" + (x - 3.2) + " " + (y - 2.5) + " a3.2 3.2 0 0 1 6.4 0", INK, 2.2) +
      dot(x, y + 2.5, 4.4, ACC);
  }
  // Curl of steam rising from hot food.
  function steam(x, y) {
    return thin("M" + x + " " + y + " q-2.6 -3.6 0 -7.2 q2.6 -3.6 0 -7.2", STEAM, 2);
  }

  // ---- food vessels ----
  // Dinner plate (rim at cy 61.5); food composes around (48, 56).
  function plateBase() {
    return sh(75, 28, 4.5) +
      el(48, 63, 27, 8.5, "#e8ddc8") +
      el(48, 61.5, 27, 8.5, CARD) +
      el(48, 61.5, 19.5, 5.8, WELL);
  }
  // Footed bowl, rim at y 48.5 filled with the contents color; toppings pile above.
  function bowlBase(contents) {
    return sh(72, 23, 4.5) +
      '<path d="M27 48.5 a21 18 0 0 0 42 0 Z" fill="' + CARD + '"/>' +
      thin("M62.5 57.5 q-2.5 5.5 -9.5 7.6", "#ece2cd", 2.6) +
      el(48, 67, 8, 2.2, "#e6dcc9") +
      el(48, 48.5, 21, 5.6, contents);
  }

  // =========================================================================
  // FOOD PLATES (~24 illustrations)
  // =========================================================================
  var FOOD = {};

  // -- Bowl of oats / porridge: cream oats, banana coins, a curl of steam.
  FOOD.oats = svgWrap(
    bowlBase("#e9d3a9") +
    thin("M36.5 50 a3 2 0 0 1 4 0", "#d9ba84", 1.4) +
    dot(42, 45.4, 3, "#f3e3b2") + dot(42, 45.4, 0.9, "#dcc27f") +
    dot(48.8, 44, 2.9, "#f3e3b2") + dot(48.8, 44, 0.9, "#dcc27f") +
    dot(55, 46.2, 2.8, "#f3e3b2") + dot(55, 46.2, 0.85, "#dcc27f") +
    steam(48, 37)
  );

  // -- Fried eggs on a plate: two whites, glossy yolks, cracked pepper, herb.
  FOOD.eggs = svgWrap(
    plateBase() +
    el(40, 56.5, 9.5, 5.6, "#fdfaf2", -6) +
    el(55.5, 57.2, 8.6, 5, "#fdfaf2", 7) +
    dot(40, 56, 3.7, YOLK) + dot(38.7, 54.8, 1.1, "#f6dc9a") +
    thin("M36.8 57.6 a3.7 3.7 0 0 0 6.4 0", "#d99c2f", 1.4) +
    dot(55.5, 56.8, 3.4, YOLK) + dot(54.3, 55.7, 1, "#f6dc9a") +
    dot(47, 53.4, 0.6, INK) + dot(49.5, 59.2, 0.6, INK) + dot(44, 60.2, 0.55, INK) +
    thin("M62.5 52.5 q2.8 -3.4 2 -7", SAGE, 1.6) +
    dot(64.6, 45.4, 1.1, SAGE) + dot(63.2, 48.4, 1, SAGE)
  );

  // -- Toast: standing slice, melting butter pat, crumb flecks.
  FOOD.toast = svgWrap(
    sh(66.5, 16.5, 3.2) +
    '<path d="M35.5 41 q0 -9 8.5 -9 q4 -4.5 8 0 q8.5 0 8.5 9 v19.5 q0 3 -3 3 h-19.5 q-3 0 -3 -3 Z" fill="#d6a05f"/>' +
    '<path d="M38.5 42 q0 -6.5 6.5 -6.5 q3 -3.5 6.5 0 q6.5 0 6.5 6.5 v16.5 q0 2 -2 2 h-15.5 q-2 0 -2 -2 Z" fill="#f0debb"/>' +
    '<rect x="44" y="46" width="8.5" height="6" rx="1.5" fill="#f6d97e"/>' +
    '<rect x="44" y="46" width="8.5" height="2.2" rx="1.1" fill="#fae9a8"/>' +
    '<path d="M46.2 52 q0 3.2 1.8 3.2 q1.6 -.3 1.2 -3.2 Z" fill="#f6d97e"/>' +
    dot(40.5, 56.5, 0.9, "#dcc18f") + dot(55.5, 55, 0.9, "#dcc18f") + dot(42, 42.5, 0.9, "#dcc18f")
  );

  // -- Pancake stack: three flapjacks, syrup drips, butter pat, on a plate.
  FOOD.pancakes = svgWrap(
    plateBase() +
    el(48, 56.5, 15, 4.8, "#d09a52") + el(48, 53, 15, 4.8, "#eccb8f") +
    el(48, 51.5, 13.5, 4.4, "#d9a258") + el(48, 48.4, 13.5, 4.4, "#f0d49a") +
    el(48, 46.8, 12, 4, "#d9a258") + el(48, 43.8, 12, 4, "#eccb8f") +
    el(48, 43.6, 9.5, 3, "#a86327") +
    '<path d="M40 45.6 q-.4 3.8 -2 4.2 q-1.4 -.5 -.8 -3.4 Z" fill="#a86327"/>' +
    '<path d="M57 45.2 q.6 3.4 2.2 3.8 q1.2 -.6 .6 -3.2 Z" fill="#a86327"/>' +
    '<rect x="44.5" y="40" width="7" height="4.4" rx="1" fill="#f8e6a4"/>' +
    '<rect x="44.5" y="40" width="7" height="1.8" rx="0.9" fill="#fcf0c4"/>'
  );

  // -- Yogurt parfait: glass cup, white swirl, berries and a leaf on top.
  FOOD.yogurt = svgWrap(
    sh(71, 15, 3.4) +
    '<path d="M36 31.5 L38 63.5 q.3 4 4.3 4 h11.4 q4 0 4.3 -4 L60 31.5 Z" fill="#f4eee0"/>' +
    '<path d="M38.4 35.5 L40 62 q.3 3 3.3 3 h9.4 q3 0 3.3 -3 L57.6 35.5 Z" fill="#fdfaf2"/>' +
    el(48, 35.5, 9.6, 2.7, CARD) +
    thin("M41.2 39 L42.6 60", "#ece2cd", 2) +
    dot(44.2, 33.6, 2.7, BERRY) + dot(50.4, 32.9, 2.5, ACC) + dot(47.2, 30.8, 2.3, BERRY_DK) +
    '<path d="M52.5 30 q3.5 -2.4 5 .4 q-2.4 2.8 -5 -.4 Z" fill="' + SAGE + '"/>'
  );

  // -- Banana: a single crescent with dark tips, ridge and highlight.
  FOOD.banana = svgWrap(
    sh(70, 21, 4) +
    '<path d="M27 46.5 q1.5 13 14 18.5 q14 6 24 -2.5 q4 -3.5 5 -9 l-4.5 -1 q-2.5 8 -11 10 q-15 3.5 -23 -16 Z" fill="#f1d05e"/>' +
    dot(27.8, 47.6, 1.8, "#8a7a3a") + dot(67.8, 54.5, 1.8, "#8a7a3a") +
    thin("M31.5 50.5 q8 13.5 22.5 11.5", "#dcb84c", 1.8) +
    thin("M33 48.5 q4.5 8 11.5 11", "#f9e9a8", 2.2)
  );

  // -- Apple: two-lobed body, stem, sage leaf, soft blush highlight.
  FOOD.apple = svgWrap(
    sh(70.5, 17, 3.8) +
    dot(42.5, 53, 11.5, "#bf4a33") + dot(53.5, 53, 11.5, "#bf4a33") +
    el(57.5, 57, 3, 5, "#a83f2a", 22) +
    el(39.5, 48.5, 2.6, 4.6, "#d27a5e", -18) +
    thin("M48 43.5 q-1 -5 1.5 -8", INK, 2) +
    '<path d="M50.5 35.5 q6.5 -3 8.5 1.5 q-4.5 4 -8.5 -1.5 Z" fill="' + SAGE + '"/>'
  );

  // -- Bowl of berries: piled rounds in berry / dark-berry / terracotta.
  FOOD.berries = svgWrap(
    bowlBase("#7c4660") +
    dot(39.5, 46, 3.3, BERRY) + dot(46.4, 44.6, 3.5, BERRY_DK) + dot(53.4, 46.2, 3.1, ACC) +
    dot(42.8, 41.4, 2.9, BERRY) + dot(49.8, 40.9, 2.8, ACC) +
    dot(43.6, 40.4, 0.7, "#d9c1cd") + dot(47.3, 43.6, 0.8, "#9c7a8c") +
    '<path d="M55.5 41.5 q4.5 -3 6.5 .5 q-3 3.5 -6.5 -.5 Z" fill="' + SAGE + '"/>'
  );

  // -- Salad: leafy pile over a sage bowl, tomato and cucumber.
  FOOD.salad = svgWrap(
    bowlBase(SAGE) +
    '<path d="M36.5 45.5 q-2.5 -7.5 5 -9.5 q4.5 6 -1 10.5 Z" fill="' + SAGE_LT + '"/>' +
    '<path d="M45.5 42.5 q1 -8.5 8.5 -7.5 q1 7.5 -6.5 9.5 Z" fill="' + SAGE + '"/>' +
    '<path d="M55.5 46 q5.5 -6.5 10.5 -2 q-2.5 6.5 -9.5 5 Z" fill="#a9b673"/>' +
    dot(43.5, 46.2, 2.9, "#c44f3c") + dot(42.4, 45, 0.9, "#e08a75") +
    dot(52.5, 47, 2.4, "#cfd9ad")
  );

  // -- Chicken plate: seared breast, greens, lemon slice.
  FOOD.chicken = svgWrap(
    plateBase() +
    '<path d="M35 56.5 q-1.5 -7 6.5 -9 q9.5 -2.5 15 1.5 q5.5 4 3 8.5 q-3 4.5 -12.5 4.5 q-9.5 0 -12 -5.5 Z" fill="#e0aa63"/>' +
    el(42, 50.5, 3, 1.6, "#edc88f", -10) +
    thin("M40.5 53 L53 51", "#b9803c", 1.8) +
    thin("M41.5 57 L54 55", "#b9803c", 1.8) +
    '<path d="M59.5 52 q5 -4.5 8.5 -.5 q-3 4.5 -8.5 .5 Z" fill="' + SAGE_LT + '"/>' +
    dot(35, 61, 3.8, "#f2d979") + dot(35, 61, 2.8, "#f8e9ae") +
    thin("M35 58.6 v4.8 M32.6 61 h4.8", "#e3c14f", 1)
  );

  // -- Steak plate: seared cut, fat cap, rosemary sprig.
  FOOD.steak = svgWrap(
    plateBase() +
    '<path d="M34.5 55 q-2 -6.5 5.5 -8.5 q8.5 -3 16.5 -1 q8 2 7 8 q-1 6 -11.5 7 q-13.5 1 -17.5 -5.5 Z" fill="#9a4a36"/>' +
    thin("M39 47.8 q9 -3 17.5 -1", "#efe0c8", 2.4) +
    thin("M41 52 L48 58", "#722f22", 1.8) +
    thin("M47 50.5 L54 56.5", "#722f22", 1.8) +
    thin("M61.5 60 q4 -2.5 7.5 -1.5", SAGE, 1.5) +
    thin("M63.5 58.6 l.8 -2.2 M66 58.4 l.8 -2.2 M64.3 60.6 l-1 2 M66.8 60.2 l-1 2", SAGE, 1.3)
  );

  // -- Salmon fillet: flake stripes, lemon, herb flecks.
  FOOD.salmon = svgWrap(
    plateBase() +
    '<path d="M34.5 53 q1 -6 9 -7 q12.5 -1.5 17.5 3.5 q3.5 3.5 .5 7 q-3.5 4.5 -13 4 q-12.5 -.5 -14 -7.5 Z" fill="' + SALMON + '"/>' +
    thin("M41 49.5 q3 3.5 2.5 8", "#f6c0aa", 2) +
    thin("M47 48.5 q3 3.5 2.5 8.5", "#f6c0aa", 2) +
    thin("M53 49 q3 3.5 2.5 8", "#f6c0aa", 2) +
    dot(63, 58.5, 4, "#f2d979") + dot(63, 58.5, 3, "#f8e9ae") +
    thin("M63 56 v5 M60.5 58.5 h5", "#e3c14f", 1) +
    dot(34, 60, 1.1, SAGE) + dot(36.5, 61.5, 1, SAGE)
  );

  // -- Poke / rice bowl: white rice, salmon cubes, avocado, sesame.
  FOOD.poke = svgWrap(
    bowlBase("#fbf7ec") +
    thin("M36.5 50 a3 2 0 0 1 4 0 M52 51 a3 2 0 0 1 4 0", "#ddd2b8", 1.4) +
    '<rect x="39" y="40.5" width="5.6" height="5.6" rx="1.2" fill="' + SALMON + '" transform="rotate(8 41.8 43.3)"/>' +
    '<rect x="46.2" y="42.4" width="5.4" height="5.4" rx="1.2" fill="' + SALMON + '" transform="rotate(-9 48.9 45.1)"/>' +
    '<path d="M56 44.5 q5.5 -4 8 .5 q-4 4.5 -8 -.5 Z" fill="#a9b673"/>' +
    '<path d="M54 41 q5 -3.5 7.5 .5 q-3.5 4 -7.5 -.5 Z" fill="' + SAGE_LT + '"/>' +
    dot(44.5, 39.5, 0.65, INK) + dot(53.5, 47.5, 0.65, INK) + dot(49, 40.2, 0.6, INK)
  );

  // -- Pasta: golden noodle nest, basil, cracked pepper.
  FOOD.pasta = svgWrap(
    plateBase() +
    thin("M34.5 56 q7 -7 14 -3 q8 4 13.5 -1", "#e9c378", 2.6) +
    thin("M36.5 59.5 q8 -6 13 -2.5 q7 4.5 12 -.5", "#e9c378", 2.6) +
    thin("M39 52.5 q6 -5 11.5 -2 q6 3 9.5 -1", "#e9c378", 2.6) +
    thin("M61.5 55.5 q3 .5 2.5 3", "#e9c378", 2.6) +
    '<path d="M47 48 q4.5 -4 7.5 -.5 q-3 4 -7.5 .5 Z" fill="' + SAGE + '"/>' +
    '<path d="M46 49.5 q-3.5 -3 -6.5 0 q2.5 3.5 6.5 0 Z" fill="' + SAGE_LT + '"/>' +
    dot(43, 58.5, 0.6, INK) + dot(55.5, 57.5, 0.6, INK) + dot(50, 60.5, 0.55, INK)
  );

  // -- Soup: warm bowl, cream swirl, herbs, rising steam.
  FOOD.soup = svgWrap(
    bowlBase("#d98a4a") +
    thin("M39.5 47.5 q4.5 3 8.5 0 q4 -3 8 0", "#f3e1c4", 2.2) +
    dot(45, 45.6, 1, SAGE) + dot(52, 48.4, 0.9, SAGE) +
    steam(43, 38) + steam(54, 36.5)
  );

  // -- Sweet potato: two roasted halves, skin rims, butter, steam.
  FOOD.potato = svgWrap(
    plateBase() +
    el(41, 55, 8.6, 5.4, "#e0823a", -12) +
    '<ellipse cx="41" cy="55" rx="8.6" ry="5.4" fill="none" stroke="#8a5340" stroke-width="2.2" transform="rotate(-12 41 55)"/>' +
    el(56.5, 57.5, 7.6, 4.8, "#e0823a", 10) +
    '<ellipse cx="56.5" cy="57.5" rx="7.6" ry="4.8" fill="none" stroke="#8a5340" stroke-width="2.2" transform="rotate(10 56.5 57.5)"/>' +
    dot(41, 54.5, 1.8, "#f8e6a4") +
    steam(49, 41)
  );

  // -- Protein shake / smoothie: tall glass, berry blend, terracotta straw.
  FOOD.shake = svgWrap(
    sh(71, 15, 3.4) +
    '<path d="M35 28.5 L37.4 65 q.3 3.8 4.1 3.8 h13 q3.8 0 4.1 -3.8 L61 28.5 Z" fill="#f4eee0"/>' +
    '<path d="M37.5 33 L39.4 62.8 q.3 2.8 3.1 2.8 h11 q2.8 0 3.1 -2.8 L58.5 33 Z" fill="#a3637f"/>' +
    el(48, 33, 10.5, 2.9, "#b97e97") +
    thin("M53.5 13.5 L48.2 35", ACC, 3) +
    thin("M41 37 L42.6 60.5", "#c293a8", 2.2) +
    dot(39.8, 30.8, 2.2, BERRY)
  );

  // -- Coffee: cup on a saucer, latte leaf, steam.
  FOOD.coffee = svgWrap(
    sh(72.5, 21, 3.4) +
    el(47.5, 65.8, 18.5, 4.4, "#e8ddc8") +
    el(47.5, 64.3, 18.5, 4.4, CARD) +
    '<path d="M34 42 L35.6 55.5 q1.2 5.8 11.9 5.8 q10.7 0 11.9 -5.8 L61 42 Z" fill="' + CARD + '"/>' +
    thin("M58.6 47 q-.8 8 -7.4 11.2", "#ece2cd", 2.4) +
    thin("M61 45.5 q6.8 .6 5.6 6.2 q-1 4.8 -6.4 4.4", "#e7dcc4", 3.4) +
    el(47.5, 42, 13.5, 3.9, "#6b4a32") +
    el(47.5, 42, 2.6, 1.3, "#e6cfa8") +
    thin("M47.5 39.8 v4.4", "#e6cfa8", 1.2) +
    steam(43.5, 34) + steam(52, 32.5)
  );

  // -- Tea / matcha: handle-less bowl-cup, green surface, foam swirl.
  FOOD.tea = svgWrap(
    sh(70.5, 16, 3.6) +
    '<path d="M33 44 q.8 15.5 15 15.5 q14.2 0 15 -15.5 Z" fill="' + CARD + '"/>' +
    thin("M59.8 48 q-1.2 7.5 -7 10", "#ece2cd", 2.4) +
    el(48, 62.5, 6.5, 2, "#e6dcc9") +
    el(48, 44, 15, 4.2, "#9fae6f") +
    thin("M42.5 43.5 q3.5 2.4 7 0", "#b9c489", 2) +
    steam(44.5, 35) + steam(53, 33.5)
  );

  // -- Pizza slice: arched crust, melted cheese, pepperoni, basil.
  FOOD.pizza = svgWrap(
    sh(72.5, 19, 3.8) +
    '<path d="M30 38 a40 40 0 0 1 36 0 L49.6 69 q-1.6 2.8 -3.2 0 Z" fill="#d99a55"/>' +
    '<path d="M33.3 41.8 a33 33 0 0 1 29.4 0 L49.3 64.5 q-1.3 2.2 -2.6 0 Z" fill="#eccb86"/>' +
    thin("M34 36.6 a36 36 0 0 1 28 0", "#eebc7d", 2.2) +
    dot(42.5, 45.5, 2.9, ACC) + dot(53.2, 46.5, 2.8, ACC) + dot(47.6, 54.5, 2.6, ACC) +
    dot(48.5, 44, 1.1, SAGE) + dot(44.5, 51, 1, SAGE)
  );

  // -- Burger: full stack — bun, lettuce ruffle, cheese drip, patty.
  FOOD.burger = svgWrap(
    sh(72, 21, 4.2) +
    '<path d="M33.5 59 h29 q.8 6 -5 6 h-19 q-5.8 0 -5 -6 Z" fill="#d99a55"/>' +
    '<rect x="31.5" y="54" width="33" height="5.6" rx="2.8" fill="#7a4634"/>' +
    '<rect x="33" y="51.8" width="30" height="3" rx="1.5" fill="#f2c14e"/>' +
    '<path d="M38.5 54.5 q.2 3.4 -1.8 3.6 q-1.6 -.6 -1 -3.6 Z" fill="#f2c14e"/>' +
    '<path d="M32 51.5 q2.5 -3.8 5.5 -1 q2.5 -3.4 5.5 -.8 q2.5 -3.2 5.5 -.6 q2.5 -3 5.5 -.5 q2.6 -2.6 5.5 .2 l-.6 3.2 h-26.5 Z" fill="' + SAGE_LT + '"/>' +
    '<path d="M33 49.5 q0 -13.5 15 -13.5 q15 0 15 13.5 Z" fill="#dd9e58"/>' +
    thin("M37.5 42.5 q2 -4.5 6.5 -5.8", "#eebc7d", 2.2) +
    el(42, 42.5, 1.3, 0.8, "#f3e3bd", -15) + el(48, 40.8, 1.3, 0.8, "#f3e3bd", 8) +
    el(54, 42.6, 1.3, 0.8, "#f3e3bd", 20) + el(45, 45.8, 1.2, 0.75, "#f3e3bd", -8) +
    el(51.5, 45.4, 1.2, 0.75, "#f3e3bd", 12)
  );

  // -- Nuts / snack: small bowl of almonds.
  FOOD.nuts = svgWrap(
    sh(69.5, 17, 3.6) +
    '<path d="M32 47.5 a16 13.5 0 0 0 32 0 Z" fill="' + CARD + '"/>' +
    el(48, 62.5, 6, 2, "#e6dcc9") +
    el(48, 47.5, 16, 4.4, "#caa05e") +
    el(42, 45, 3.1, 1.9, "#c08a52", -22) +
    el(48.6, 43.8, 3.2, 2, "#b27c45", 14) +
    el(54.4, 45.6, 3, 1.9, "#c08a52", -6) +
    el(45.4, 41.8, 2.9, 1.8, "#b27c45", 42) +
    dot(41.3, 44.4, 0.7, "#e3b988") + dot(53.7, 45, 0.7, "#e3b988")
  );

  // -- Cheese wedge: holes, rind band, edge highlight.
  FOOD.cheese = svgWrap(
    sh(69.5, 19, 3.8) +
    '<path d="M29.5 60.5 L47 36 q1.4 -2 2.8 0 L67 60.5 q1.6 2.6 -1.8 2.6 H31.3 q-3.4 0 -1.8 -2.6 Z" fill="#f2cf7d"/>' +
    '<path d="M30.2 59.5 l-.7 1 q-1.6 2.6 1.8 2.6 h33.9 q3.4 0 1.8 -2.6 l-.7 -1 Z" fill="#e0b257"/>' +
    dot(44, 52.5, 2.6, "#dab35e") + dot(52.5, 56, 2, "#dab35e") +
    dot(47.6, 44.5, 1.6, "#dab35e") + dot(38.5, 57, 1.5, "#dab35e") +
    thin("M45.5 39.5 L34 56", "#f9e6ad", 2)
  );

  // -- Generic plate (fallback): composed plate with cutlery, grain, protein, greens.
  FOOD.plate = svgWrap(
    plateBase() +
    thin("M15.8 52.5 V69.5", INK, 1.8) +
    thin("M13.7 46.5 l.3 5.5 M15.8 46.2 v5.8 M17.9 46.5 l-.3 5.5", INK, 1.6) +
    thin("M80.2 52.5 V69.5", INK, 1.8) +
    '<path d="M80.2 52.5 v-7.5 q3.4 1.2 3.4 5.2 q0 1.9 -3.4 2.3 Z" fill="' + INK + '"/>' +
    el(40.5, 55.5, 7.4, 4, "#fbf7ec") +
    thin("M36.5 54.5 a3 2 0 0 1 4 0", "#ddd2b8", 1.3) +
    '<path d="M49.5 53 q1 -4.5 7 -4.5 q7.5 0 8 5 q.4 4.5 -7 5 q-7.5 .5 -8 -5.5 Z" fill="#dba35c"/>' +
    thin("M52.5 53.5 L60 52.5", "#b9803c", 1.5) +
    '<path d="M45 49.5 q3.5 -5 7 -2 q-2 5 -7 2 Z" fill="' + SAGE_LT + '"/>' +
    dot(46.5, 58.2, 1.8, "#c44f3c")
  );

  // Ordered keyword rules — most specific first. Caller text is ONLY tested,
  // never embedded.
  var FOOD_RULES = [
    [/shake|smoothie/, "shake"],
    [/matcha|\btea\b|chai/, "tea"],
    [/coffee|espresso|latte|cappuccino|americano|cold ?brew|mocha|macchiato/, "coffee"],
    [/oat|porridge|muesli|granola|cereal/, "oats"],
    [/pancake|waffle|crepe|french toast/, "pancakes"],
    [/yogurt|yoghurt|skyr|parfait|kefir/, "yogurt"],
    [/egg|omelet|frittata|scramble/, "eggs"],
    [/poke|sushi|rice bowl|grain bowl|burrito/, "poke"],
    [/pizza/, "pizza"],
    [/burger|slider/, "burger"],
    [/pasta|noodle|spaghetti|penne|ramen|lasagn|gnocchi|mac and cheese/, "pasta"],
    [/soup|stew|chili|broth|curry/, "soup"],
    [/salmon|tuna|fish|cod|shrimp|prawn|seafood|trout|sardine/, "salmon"],
    [/chicken|turkey|poultry/, "chicken"],
    [/steak|beef|pork|lamb|\bmeat\b|ribeye|sirloin|bacon|sausage/, "steak"],
    [/salad|greens|kale|spinach|veg|broccoli|asparagus|slaw/, "salad"],
    [/toast|bread|sandwich|bagel|wrap|avocado|croissant|tortilla/, "toast"],
    [/potato|fries|\byam\b/, "potato"],
    [/banana/, "banana"],
    [/apple|pear|peach|orange|plum|nectarine/, "apple"],
    [/berr|grape|fruit|melon|mango|kiwi|cherry|fig\b/, "berries"],
    [/nut\b|nuts|almond|peanut|cashew|pistachio|walnut|trail mix|snack|seeds|\bbar\b/, "nuts"],
    [/cheese|cottage|milk|dairy|cream/, "cheese"],
    [/rice|quinoa|couscous|bowl/, "poke"]
  ];

  function food(text) {
    var t = text == null ? "" : String(text).toLowerCase();
    for (var i = 0; i < FOOD_RULES.length; i++) {
      if (FOOD_RULES[i][0].test(t)) return FOOD[FOOD_RULES[i][1]];
    }
    return FOOD.plate;
  }

  // =========================================================================
  // EXERCISE FIGURES — duotone ink line-art, one terracotta implement accent
  // =========================================================================
  var EX = {};

  // -- Squat: front view at depth, barbell across the shoulders.
  EX.squat = svgWrap(
    sh(76, 26, 4) +
    ln("M20 37 H76") +
    plateEnd(21.5, 37, 6) + plateEnd(74.5, 37, 6) +
    headAt(48, 28.5) +
    ln("M48 35 V52") +
    ln("M43 41 L33.5 37.5 M53 41 L62.5 37.5") +
    ln("M48 52 L36 59 37 72 M48 52 L60 59 59 72") +
    ln("M32.5 72 H41 M55 72 H63.5")
  );

  // -- Hinge: deadlift at the bottom, flat back, plate on the floor.
  EX.hinge = svgWrap(
    sh(75, 24, 4) +
    ln("M40 71 H50") +
    ln("M44.5 71 L46 58 37.5 45") +
    ln("M37.5 45 L57 33.5") +
    headAt(62, 30) +
    ln("M56 34.5 L61.5 54") +
    plateEnd(62, 62.5, 8)
  );

  // -- Horizontal press: bench press, bar locked out over the chest.
  EX.pressH = svgWrap(
    sh(76.5, 27, 3.5) +
    ln("M28 60 H68 M34 60 V72 M62 60 V72") +
    ln("M42 55.5 H58.5") +
    headAt(64, 54.5) +
    ln("M42 55.5 L31.5 50.5 27.5 71") +
    ln("M24 71 H31") +
    ln("M57.5 54 V41") +
    plateEnd(57.5, 33.5, 6.4)
  );

  // -- Vertical press: standing overhead lockout, front view.
  EX.pressV = svgWrap(
    sh(76, 22, 4) +
    ln("M26 21.5 H70") +
    plateEnd(26.5, 21.5, 5.6) + plateEnd(69.5, 21.5, 5.6) +
    ln("M42.5 39 L37.5 23.5 M53.5 39 L58.5 23.5") +
    headAt(48, 31.5) +
    ln("M48 38 V56") +
    ln("M48 56 L42.5 72 M48 56 L53.5 72") +
    ln("M39 72 H46 M50 72 H57")
  );

  // -- Row: bent-over barbell row, bar pulled to the belly.
  EX.row = svgWrap(
    sh(75, 24, 4) +
    ln("M38 71 H48") +
    ln("M43 71 L45 58 36 44.5") +
    ln("M36 44.5 L57.5 34") +
    headAt(62.5, 30.5) +
    ln("M56 35 L59.5 45.5 51.5 48.5") +
    plateEnd(51, 54.5, 6)
  );

  // -- Pull: pull-up, chest to the bar, terracotta bar caps.
  EX.pull = svgWrap(
    sh(78.5, 16, 3) +
    ln("M26 20 H70") +
    dot(25.5, 20, 2.7, ACC) + dot(70.5, 20, 2.7, ACC) +
    ln("M40 21 L36.5 31 44 37 M56 21 L59.5 31 52 37") +
    headAt(48, 30.5) +
    ln("M48 37 V54") +
    ln("M48 54 L43 63 49 69 M48 54 L53 63 47.5 69.5")
  );

  // -- Curl: alternating dumbbell curl, elbow pinned.
  EX.curl = svgWrap(
    sh(76, 18, 3.5) +
    headAt(45, 25.5) +
    ln("M45 31 V55") +
    ln("M45 55 L41.5 72 M45 55 L49.5 72") +
    ln("M38.5 72 H44.5 M47 72 H53.5") +
    ln("M45 34 L42.5 48") +
    db(42, 52.5, 3.6) +
    ln("M45 34 L49.5 46.5 58.5 41") +
    db(60.8, 39.6, 4.4) + dot(60.8, 39.6, 1.2, CREAM)
  );

  // -- Triceps: cable pushdown, terracotta handle.
  EX.triceps = svgWrap(
    sh(76, 18, 3.5) +
    thin("M59 12 L57.2 49", INK, 1.6) +
    headAt(43.5, 26) +
    ln("M44.5 32 L46.5 55") +
    ln("M46.5 55 L42 72 M46.5 55 L51.5 72") +
    ln("M39 72 H45 M48.5 72 H55") +
    ln("M45 35 L51.5 43.5 56.8 49.5") +
    thin("M51.5 51 H63", ACC, 4)
  );

  // -- Lunge / split squat: rear knee dropping, dumbbells at the sides.
  EX.lunge = svgWrap(
    sh(76, 26, 4) +
    headAt(47, 23.5) +
    ln("M47 29.5 V48") +
    ln("M47 48 L59 56 57 71") +
    ln("M53 71 H63") +
    ln("M47 48 L39 62.5 30.5 68.5") +
    ln("M47 32.5 L44.5 50") +
    db(44, 54, 3.5) +
    ln("M47 32.5 L50 50") +
    db(50.5, 54.3, 4) + dot(50.5, 54.3, 1.1, CREAM)
  );

  // -- Raise: lateral raise at the top, slight elbow bend.
  EX.raise = svgWrap(
    sh(76, 20, 3.5) +
    headAt(48, 26) +
    ln("M48 32 V55") +
    ln("M48 55 L43 72 M48 55 L53 72") +
    ln("M39.5 72 H46.5 M49.5 72 H56.5") +
    ln("M48 35.5 L38 32.5 30 35 M48 35.5 L58 32.5 66 35") +
    db(28, 35.8, 4) + db(68, 35.8, 4)
  );

  // -- Calf raise: heel high on a block, dumbbell in hand.
  EX.calf = svgWrap(
    sh(75.5, 20, 3.5) +
    '<rect x="40" y="64" width="18" height="8" rx="1.5" fill="#e2d6c0"/>' +
    ln("M44.5 59.5 L54 63.5") +
    ln("M47.5 60.5 L49 44 49 27") +
    headAt(49, 21) +
    ln("M49 31 L53.5 44") +
    db(54.3, 47.6, 3.6) +
    ln("M49 31 L44.5 43.5")
  );

  // -- Core: plank on the forearms, terracotta mat.
  EX.core = svgWrap(
    sh(74.5, 27, 3) +
    thin("M25 70.5 H71", ACC, 3.5) +
    headAt(27.5, 45) +
    ln("M34 48.5 L33 66 M33 66 H43") +
    ln("M34 48.5 L52 52.5 67 59.5") +
    ln("M67 59.5 L69.5 66")
  );

  // -- Carry: farmer carry mid-stride, a kettlebell in each hand.
  EX.carry = svgWrap(
    sh(76, 22, 4) +
    headAt(47, 21.5) +
    ln("M47 27.5 V49") +
    ln("M47 49 L55 60 53 71 M50 71 H58") +
    ln("M47 49 L40 59.5 35.5 69") +
    ln("M47 30.5 L43.5 50") +
    kb(43, 55) +
    ln("M47 30.5 L50.5 50") +
    kb(51, 55)
  );

  // -- Cardio: runner mid-flight, motion lines, terracotta shoe.
  EX.cardio = svgWrap(
    sh(76, 20, 3.5) +
    thin("M23 33 H31 M20.5 41.5 H28.5", MOTION, 2) +
    headAt(57.5, 24.5) +
    ln("M53.5 30.5 L47 44.5") +
    ln("M52.5 32.5 L60.5 36.5 57 43.5 M52.5 32.5 L45 39 49.5 45") +
    ln("M47 44.5 L58 50.5 55.5 60.5 M47 44.5 L38 53.5 29.5 59.5") +
    thin("M54.5 60.8 L61.5 62.3", ACC, 3.4)
  );

  // -- Stretch: seated forward fold over straight legs, terracotta mat.
  EX.stretch = svgWrap(
    sh(74.5, 26, 3) +
    thin("M26 70.5 H70", ACC, 3.5) +
    ln("M33 66 H66 M66 66 V60") +
    ln("M33 64.5 L46.5 50") +
    headAt(51.5, 47.5) +
    ln("M46.5 50 L60 60")
  );

  // -- Generic kettlebell still-life (final fallback): flat-volume, terracotta.
  EX.kettlebell = svgWrap(
    sh(72.5, 18, 4) +
    thin("M41.5 47 q-1.5 -11.5 6.5 -11.5 q8 0 6.5 11.5", ACC_DEEP, 5.4) +
    dot(48, 55, 13.5, ACC) +
    '<path d="M57.6 45.4 A13.5 13.5 0 0 1 57.6 64.6 A17 17 0 0 0 57.6 45.4 Z" fill="' + ACC_DEEP + '"/>' +
    el(42.5, 49.5, 3.6, 5, "#cd7e58", -18)
  );

  // Ordered name rules — most specific first (e.g. "leg curl" before "curl",
  // "split squat" before "squat", "overhead press" before generic "press").
  var EX_RULES = [
    [/leg curl/, "hinge"],
    [/leg ext/, "squat"],
    [/calf/, "calf"],
    [/plank|crunch|sit ?up|sit-up|ab wheel|\babs?\b|core|hollow|dead ?bug|rollout|leg raise|knee raise|l-sit|pallof|woodchop|russian twist/, "core"],
    [/face ?pull/, "row"],
    [/pull|chin/, "pull"],
    [/deadlift|\brdl\b|romanian|hip thrust|swing|good ?morning|hinge|clean|snatch|back ext/, "hinge"],
    [/lunge|split squat|step ?up|step-up|pistol|bulgarian/, "lunge"],
    [/squat|leg press|hack/, "squat"],
    [/(overhead|shoulder|military|arnold|push|strict|viking|landmine) press|\bohp\b/, "pressV"],
    [/bench|push ?-?up|pushup|\bdips?\b|fly|flye|pec|chest/, "pressH"],
    [/\brow/, "row"],
    [/pushdown|push-down|skull|tricep|kickback|extension|jm press/, "triceps"],
    [/curl/, "curl"],
    [/raise|shrug/, "raise"],
    [/carry|farmer|suitcase|yoke|sled/, "carry"],
    [/run|jog|sprint|bike|cycl|treadmill|elliptical|stair|cardio|hiit|burpee|jump|rope/, "cardio"],
    [/stretch|mobility|yoga|foam|pigeon|cat ?cow|cossack/, "stretch"],
    [/press/, "pressH"]
  ];

  // Muscle-group fallbacks, scanned in order (substring match).
  var MUSCLE_RULES = [
    ["rear", "row"], ["chest", "pressH"], ["pec", "pressH"],
    ["lat", "pull"], ["back", "row"],
    ["quad", "squat"], ["hamstring", "hinge"], ["posterior", "hinge"], ["glute", "hinge"],
    ["calv", "calf"], ["calf", "calf"], ["leg", "squat"],
    ["shoulder", "raise"], ["delt", "raise"],
    ["bicep", "curl"], ["tricep", "triceps"], ["arm", "curl"], ["forearm", "curl"],
    ["core", "core"], ["ab", "core"],
    ["cardio", "cardio"], ["condition", "cardio"]
  ];

  function exercise(name, muscleGroup) {
    var n = name == null ? "" : String(name).toLowerCase();
    for (var i = 0; i < EX_RULES.length; i++) {
      if (EX_RULES[i][0].test(n)) return EX[EX_RULES[i][1]];
    }
    var mg = muscleGroup == null ? "" : String(muscleGroup).toLowerCase();
    for (var j = 0; j < MUSCLE_RULES.length; j++) {
      if (mg.indexOf(MUSCLE_RULES[j][0]) !== -1) return EX[MUSCLE_RULES[j][1]];
    }
    return EX.kettlebell;
  }

  // =========================================================================
  // ACTIVITY FIGURES
  // =========================================================================
  var ACT = {};

  // -- Run: same runner as the cardio movement plate.
  ACT.run = EX.cardio;

  // -- Ride: bicycle with terracotta frame, rider tucked.
  ACT.ride = svgWrap(
    sh(75, 30, 3.5) +
    '<circle cx="30" cy="61" r="10" fill="none" stroke="' + INK + '" stroke-width="2.5"/>' +
    dot(30, 61, 1.6, INK) +
    '<circle cx="66" cy="61" r="10" fill="none" stroke="' + INK + '" stroke-width="2.5"/>' +
    dot(66, 61, 1.6, INK) +
    thin("M30 61 L47 59 L42.5 43.5 M47 59 L61 45 L42.5 43.5 M61 45 L66 61", ACC, 2.5) +
    ln("M40 42.5 H46") +
    ln("M61 45 L64.5 40.5") +
    headAt(60.5, 28.5) +
    ln("M43 41 L56.5 31.5") +
    ln("M55.5 32.5 L63.5 41") +
    ln("M43 41 L52.5 50 48.5 58.5") +
    thin("M45.5 59 H51.5", INK, 2.5) +
    dot(47, 59, 1.5, INK)
  );

  // -- Swim: freestyle between two waves, terracotta cap.
  ACT.swim = svgWrap(
    sh(70.5, 26, 3.5) +
    thin("M22 56.5 q5 -4 10 0 t10 0 t10 0 t10 0 t10 0", WATER_LT, 2.2) +
    ln("M55 53.5 L35 50.5") +
    ln("M35 50.5 l-5.5 -3 M35 50.5 l-4 3.5") +
    ln("M42 51.5 q5 -11 15 -6.5") +
    '<circle cx="60.5" cy="51.5" r="4.3" fill="' + ACC + '" stroke="' + INK + '" stroke-width="2.5"/>' +
    thin("M20 61.5 q5 -4 10 0 t10 0 t10 0 t10 0 t10 0 t6 0", WATER, 2.4) +
    dot(63, 45.5, 1.3, WATER_LT) + dot(59.5, 42.5, 1, WATER_LT)
  );

  // -- Walk: easy upright stride, terracotta shoes.
  ACT.walk = svgWrap(
    sh(76, 20, 3.5) +
    headAt(48, 23.5) +
    ln("M48 29.5 V50") +
    ln("M48 33 L53.5 45.5 M48 33 L42.5 44.5") +
    ln("M48 50 L55 61 53 71 M48 50 L42 61 37.5 69.5") +
    thin("M50 71.5 H58.5", ACC, 3.2) +
    thin("M34.5 70 L40.5 71", ACC, 3)
  );

  // -- Hike: climbing a slope with a pole and a terracotta pack.
  ACT.hike = svgWrap(
    sh(71.5, 24, 3.5) +
    thin("M22 67 L74 51", MOTION, 2.5) +
    '<rect x="43.5" y="26.5" width="7" height="12.5" rx="3.4" fill="' + ACC + '" transform="rotate(12 47 32)"/>' +
    ln("M52 27.5 L49 41.5") +
    headAt(53.5, 21.5) +
    ln("M49 41.5 L56.5 48 57 56 M49 41.5 L43 50.5 44 60") +
    ln("M54.5 56.8 L60 55.2 M41.5 60.8 L46.5 59.4") +
    ln("M52 29 L59 38") +
    thin("M59.5 36.5 L63.5 54.5", INK, 2) +
    ln("M52 29 L46.5 39.5")
  );

  // -- Row: erg at the finish, leaning back, terracotta flywheel.
  ACT.row = svgWrap(
    sh(74.5, 27, 3.5) +
    ln("M24 64 H72") +
    thin("M30 64 V70 M62 64 V70", INK, 2.2) +
    dot(69, 53, 6, ACC) + dot(69, 53, 1.7, CREAM) +
    thin("M69 59 V64", INK, 2.2) +
    ln("M37 61.5 H45") +
    thin("M41 61.5 V64", INK, 2) +
    ln("M41 59 L54 56.5 62.5 53.5") +
    thin("M60.5 50 L64.5 57.5", INK, 2.4) +
    ln("M41 59 L33.5 46") +
    headAt(31.5, 41) +
    thin("M47 49.5 L62.5 51.5", "#a4977c", 1.6) +
    ln("M34.5 47 L45.5 49.5") +
    ln("M46 46.5 V52.5")
  );

  // -- Yoga: tree pose on a terracotta mat, hands overhead.
  ACT.yoga = svgWrap(
    sh(74.5, 24, 3) +
    thin("M28 71.5 H68", ACC, 3.5) +
    ln("M48 52 V71") +
    ln("M48 52 L57 57.5 50.5 62") +
    ln("M48 37 V52") +
    headAt(48, 31) +
    ln("M48 40 L40.5 32 46 23.5 M48 40 L55.5 32 50 23.5")
  );

  // -- Generic pulse (fallback): heartbeat trace with a terracotta beat.
  ACT.pulse = svgWrap(
    sh(66, 20, 3) +
    ln("M22 52 H35 L41 38 49 63 55 45 59 52 H69") +
    dot(70.5, 52, 2.8, ACC)
  );

  var ACT_RULES = [
    [/\brow|erg\b|kayak|paddle|canoe/, "row"],
    [/ride|rode|riding|bike|cycl|spin|mtb|gravel/, "ride"],
    [/swim|swam/, "swim"],
    [/walk/, "walk"],
    [/hike|hiking|hiked|trek|fell/, "hike"],
    [/run|jog|sprint|tempo|interval|5k|10k|marathon|trail/, "run"],
    [/yoga|stretch|mobility|pilates/, "yoga"]
  ];

  function activity(type) {
    var t = type == null ? "" : String(type).toLowerCase();
    for (var i = 0; i < ACT_RULES.length; i++) {
      if (ACT_RULES[i][0].test(t)) return ACT[ACT_RULES[i][1]];
    }
    return ACT.pulse;
  }

  // =========================================================================
  // Public API
  // =========================================================================
  root.CairnArt = {
    food: food,
    exercise: exercise,
    activity: activity
  };
})(typeof window !== "undefined" ? window : globalThis);
