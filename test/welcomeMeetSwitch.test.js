// A first open that skips Hello/Connect straight to Meet (a provider already signed in)
// names the provider in one quiet line with a way to switch — "Connected through Claude ·
// change" — and change leads back to Hello. Reached by choosing (a pick on Hello, Connect's
// hello), Meet says nothing extra. The provider's label is escaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClientModule } from "./_dom.mjs";

const PROVIDER = {
  name: "claude",
  label: "Claude",
  plan: "Claude Pro or Max",
  usable: true,
  present: true,
  installable: true,
  canLogin: true,
  configured: true,
  signedIn: true,
};

function client() {
  return loadClientModule(["html-utils", "ui-stone-model", "ui-stone", "welcome-model", "welcome-client"]);
}

test("meetHtml: the switchable form names the provider once, with a change control", () => {
  const win = client();
  const html = win.CairnWelcomeClient.meetHtml(PROVIDER, { switchable: true });
  assert.match(html, /class="wel-via">Connected through Claude · <button[^>]*data-wel-change[^>]*>change<\/button>/);
  assert.equal(html.match(/Connected through/g).length, 1, "the opener does not say it twice");
  const plain = win.CairnWelcomeClient.meetHtml(PROVIDER);
  assert.doesNotMatch(plain, /data-wel-change/, "reached by choosing: no switch line");
  assert.match(plain, /Connected through Claude\. Tell me/);
});

test("meetHtml: the provider label is escaped", () => {
  const win = client();
  const html = win.CairnWelcomeClient.meetHtml({ ...PROVIDER, label: `<img src=x onerror=1>"` }, { switchable: true });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

function welcomeScreen(model) {
  const urls = [];
  const painted = [];
  const win = loadClientModule(
    ["html-utils", "ui-stone-model", "ui-stone", "welcome-model", "welcome-client", "welcome-screen"],
    {
      globals: {
        history: {
          pushState: (_s, _t, url) => urls.push(url),
          replaceState: (_s, _t, url) => urls.push(url),
        },
        reducedMotion: () => true,
        CairnCoachLink: { peek: () => model, read: async () => model, invalidate: () => {} },
        CairnWelcomeConnect: { mount: () => () => {} },
        CairnWelcomeMeet: {
          mount: (pane) => {
            painted.push(pane.className);
            return () => {};
          },
        },
      },
    }
  );
  return { win, urls, painted };
}

const MODEL = { providers: [PROVIDER], ready: [PROVIDER], smallDisk: null };

test("opened straight to Meet: the switch line shows, and change goes back to Hello", () => {
  const env = welcomeScreen(MODEL);
  env.win.CairnWelcome.open({ stage: "meet", agent: "claude", replace: true });
  const root = env.win.document.getElementById("welcome");
  const change = root.querySelector("[data-wel-change]");
  assert.ok(change, "the switch is offered");
  assert.match(root.querySelector(".wel-via").textContent, /Connected through Claude/);
  change.click();
  assert.equal(env.urls.at(-1), "/app/welcome");
  assert.equal(root.dataset.stage, "hello");
  // Picking the same signed-in provider on Hello goes to Meet — chosen, so no switch line.
  root.querySelector('[data-wel-pick="claude"]').click();
  assert.equal(root.dataset.stage, "meet");
  assert.equal(root.querySelector("[data-wel-change]"), null);
});
