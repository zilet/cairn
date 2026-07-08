import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsScreen = readFileSync(path.join(root, "src/client/settings-screen.ts"), "utf8");
const settingsTypes = readFileSync(path.join(root, "src/client/settings-screen-types.d.ts"), "utf8");
const chatScreen = readFileSync(path.join(root, "src/client/chat-screen.ts"), "utf8");
const swrCache = readFileSync(path.join(root, "src/client/swr-cache.ts"), "utf8");
const dayFuelController = readFileSync(path.join(root, "src/client/day-fuel-controller.ts"), "utf8");
const memoryController = readFileSync(path.join(root, "src/client/me-memory-controller.ts"), "utf8");
const familyController = readFileSync(path.join(root, "src/client/family-controller.ts"), "utf8");

test("Settings paints from an aggregate SWR snapshot before revalidating", () => {
  assert.match(settingsTypes, /type SettingsScreenBundle = \{/);
  assert.match(settingsScreen, /const SETTINGS_SCREEN_CACHE_KEY = "settings:screen"/);
  assert.match(settingsScreen, /async function fetchSettingsBundle\(\): Promise<SettingsScreenBundle>/);
  assert.match(settingsScreen, /const peek = peekCached<SettingsScreenBundle>\(SETTINGS_SCREEN_CACHE_KEY\)/);
  assert.match(settingsScreen, /renderSettingsBundle\(peek\.data\)/);
  assert.match(settingsScreen, /void fetchSettingsBundle\(\)/);
  assert.match(settingsScreen, /swrSet\(SETTINGS_SCREEN_CACHE_KEY, bundle\)/);
  assert.match(settingsScreen, /document\.body\.classList\.contains\("savebar-open"\)/);
  assert.match(settingsScreen, /swrInvalidate\(SETTINGS_SCREEN_CACHE_KEY\)/);

  const warmPaint = settingsScreen.indexOf("renderSettingsBundle(peek.data)");
  const revalidate = settingsScreen.indexOf("void fetchSettingsBundle()");
  assert.ok(warmPaint > -1 && revalidate > warmPaint, "warm Settings paint happens before network revalidation");
});

test("Chat paints the cached live thread and does not erase it on a failed hydrate", () => {
  assert.match(chatScreen, /const CHAT_LIVE_CACHE_KEY = "chat:live:limit:200"/);
  assert.match(chatScreen, /peekCached<ChatScreenMessage\[\]>\(CHAT_LIVE_CACHE_KEY\)/);
  assert.match(chatScreen, /drawChat\(cachedMessages\.data\)/);
  assert.match(chatScreen, /if \(!fetched && cachedMessages\) return/);
  assert.match(chatScreen, /swrSet\(CHAT_LIVE_CACHE_KEY, msgs\)/);
  assert.match(chatScreen, /swrSet\(CHAT_LIVE_CACHE_KEY, \[\]\)/);

  const cachedPeek = chatScreen.indexOf("const cachedMessages = peekCached");
  const apiFetch = chatScreen.indexOf('await api("/chat?limit=200")');
  assert.ok(cachedPeek > -1 && apiFetch > cachedPeek, "cached chat paint is attempted before the live fetch");
});

test("Track D surfaces use cached-first paint and shared optimistic mutations", () => {
  assert.match(swrCache, /function optimisticMutation<T, R = unknown>/);
  assert.match(swrCache, /fallback\(error, optimistic, previous\)/);
  assert.match(swrCache, /Object\.assign\(globalThis,[\s\S]*optimisticMutation/);

  assert.match(dayFuelController, /function dayFuelCacheKey\(\): string/);
  assert.match(dayFuelController, /peekCached<DayFuelControllerDay>\(key\)/);
  assert.match(dayFuelController, /paintSWR\(\{[\s\S]*path: "\/nutrition\/day" \+ qs/);
  assert.match(dayFuelController, /optimisticMutation<DayFuelControllerDay>\(\{[\s\S]*withFuelEntry\(current, id, body\)/);
  assert.doesNotMatch(dayFuelController, /options\.onRerender\?\.\(\)/);

  assert.match(memoryController, /const ME_MEMORY_CACHE_KEY = "me:memory"/);
  assert.match(memoryController, /peekCached<MeMemoryRow\[\]>\(ME_MEMORY_CACHE_KEY\)/);
  assert.match(memoryController, /cachedApi\("\/memory", \{[\s\S]*key: ME_MEMORY_CACHE_KEY/);
  assert.match(memoryController, /optimisticMutation<MeMemoryRow\[\]>/);

  assert.match(familyController, /const FAMILY_CACHE_KEY = "me:family"/);
  assert.match(familyController, /peekCached<FamilyControllerMember\[\]>\(FAMILY_CACHE_KEY\)/);
  assert.match(familyController, /cachedApi\("\/family", \{[\s\S]*key: FAMILY_CACHE_KEY/);
  assert.match(familyController, /optimisticMutation<FamilyControllerMember\[\]>/);
});
