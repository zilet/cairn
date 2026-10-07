// A fake browser history + location for client tests that drive navigation (the drill
// controller's ?peek= entries, a day page's Back). pushState/replaceState/back/forward
// behave like the browser's for one tab; back/forward fire `onPop` synchronously, the
// way startup.ts's popstate listener runs (it asks CairnDrill.popped() first).

export function createNav(start = "/app/today") {
  const entries = [{ url: start, state: null }];
  let index = 0;
  const nav = { onPop: null, pops: 0 };
  const parsed = () => new URL(entries[index].url, "http://cairn.local");
  const location = {
    get pathname() {
      return parsed().pathname;
    },
    get search() {
      return parsed().search;
    },
    get hash() {
      return parsed().hash;
    },
    get href() {
      return parsed().href;
    },
  };
  const clone = (s) => (s == null ? null : JSON.parse(JSON.stringify(s)));
  const history = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[index].state;
    },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ url: String(url), state: clone(state) });
      index = entries.length - 1;
    },
    replaceState(state, _title, url) {
      entries[index] = { url: String(url ?? entries[index].url), state: clone(state) };
    },
    back() {
      if (index === 0) return;
      index -= 1;
      nav.pops += 1;
      nav.onPop?.();
    },
    forward() {
      if (index >= entries.length - 1) return;
      index += 1;
      nav.pops += 1;
      nav.onPop?.();
    },
  };
  nav.location = location;
  nav.history = history;
  nav.url = () => `${location.pathname}${location.search}`;
  nav.entries = () => entries.map((e) => e.url);
  return nav;
}
