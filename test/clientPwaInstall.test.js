import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeButton {
  constructor() {
    this.disabled = false;
    this.handlers = {};
  }

  addEventListener(name, handler) {
    this.handlers[name] = handler;
  }

  click() {
    return this.handlers.click?.();
  }
}

class FakePhoneCoach {
  constructor(owner) {
    this.owner = owner;
    this.className = "";
    this.dataset = {};
    this.removed = false;
    this._html = "";
  }

  set innerHTML(value) {
    this._html = value;
    this.dismiss = value.includes("phone-coach-dismiss") ? new FakeButton() : null;
    this.install = value.includes("phone-coach-install") ? new FakeButton() : null;
  }

  get innerHTML() {
    return this._html;
  }

  querySelector(selector) {
    if (selector === ".phone-coach-dismiss") return this.dismiss;
    if (selector === ".phone-coach-install") return this.install;
    return null;
  }

  remove() {
    this.removed = true;
  }
}

class FakeContainer {
  constructor() {
    this.children = [];
  }

  querySelector(selector) {
    if (selector !== ".phone-coach") return null;
    return this.children.find((child) => !child.removed && child.className.includes("phone-coach")) || null;
  }

  append(el) {
    this.children.push(el);
  }
}

function loadPwaCoach(options = {}) {
  const handlers = {};
  const store = new Map();
  const created = [];
  const context = {
    Object,
    Promise,
    RegExp,
    String,
    navigator: {
      userAgent: options.userAgent || "",
      maxTouchPoints: options.maxTouchPoints || 0,
      standalone: options.standalone || false,
    },
    localStorage: {
      getItem: (key) => store.get(key) || null,
      setItem: (key, value) => store.set(key, String(value)),
    },
    document: {
      body: {
        contains: (el) => !el.removed,
      },
      createElement: () => {
        const el = new FakePhoneCoach();
        created.push(el);
        return el;
      },
      querySelectorAll: (selector) => (selector === ".phone-coach" ? created.filter((el) => !el.removed) : []),
    },
  };
  context.window = {
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
    matchMedia: () => ({ matches: !!options.displayStandalone }),
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/pwa-install-coach.js"), "utf8"), context);
  return { pwa: context.CairnPwaInstall, handlers, store, created, FakeContainer };
}

test("PWA install coach detects honest install paths", () => {
  assert.equal(loadPwaCoach({ userAgent: "Mozilla/5.0 (iPhone)" }).pwa.getInstallGuidance().mode, "ios");
  assert.equal(
    loadPwaCoach({ userAgent: "Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15" }).pwa.getInstallGuidance().mode,
    "safari-desktop",
  );
  assert.equal(loadPwaCoach({ userAgent: "Mozilla/5.0 Chrome/125.0" }).pwa.getInstallGuidance().mode, "chromium-menu");
  assert.equal(loadPwaCoach({ userAgent: "Mozilla/5.0 Firefox/125.0" }).pwa.getInstallGuidance(), null);
  assert.equal(loadPwaCoach({ displayStandalone: true }).pwa.isStandalonePWA(), true);
  assert.equal(loadPwaCoach({ displayStandalone: true }).pwa.getInstallGuidance(), null);
});

test("PWA install coach renders, dismisses, upgrades prompt mode, and cleans installed banners", async () => {
  const { pwa, handlers, store, created, FakeContainer: Container } = loadPwaCoach({ userAgent: "Mozilla/5.0 Chrome/125.0" });
  const container = new Container();

  pwa.renderPhoneCoachBanner(container);
  pwa.renderPhoneCoachBanner(container);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].dataset.coachMode, "chromium-menu");
  assert.match(container.children[0].innerHTML, /Install Cairn as an app/);

  container.children[0].dismiss.click();
  assert.equal(store.get("cairn_phone_coach_dismissed"), "1");
  assert.equal(container.children[0].removed, true);

  store.delete("cairn_phone_coach_dismissed");
  let prevented = false;
  let prompted = false;
  handlers.beforeinstallprompt({
    preventDefault: () => {
      prevented = true;
    },
    prompt: () => {
      prompted = true;
    },
    userChoice: Promise.resolve({ outcome: "dismissed" }),
  });

  assert.equal(prevented, true);
  assert.equal(pwa.getInstallGuidance().mode, "prompt");
  const promptContainer = new Container();
  pwa.renderPhoneCoachBanner(promptContainer);
  assert.equal(promptContainer.children[0].dataset.coachMode, "prompt");
  assert.match(promptContainer.children[0].innerHTML, /phone-coach-install/);
  await promptContainer.children[0].install.click();
  assert.equal(prompted, true);

  pwa.renderPhoneCoachBanner(promptContainer);
  assert.equal(promptContainer.children.filter((child) => !child.removed).length, 1);
  handlers.appinstalled();
  assert.equal(store.get("cairn_phone_coach_dismissed"), "1");
  assert.equal(created.every((el) => el.removed), true);
});
