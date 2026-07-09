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
const setActions = readFileSync(path.join(root, "src/client/today-session-set-actions.ts"), "utf8");
const feedbackClient = readFileSync(path.join(root, "src/client/today-session-feedback-client.ts"), "utf8");
const todayScreen = readFileSync(path.join(root, "src/client/today-screen.ts"), "utf8");
const lifeTimeline = readFileSync(path.join(root, "src/client/life-timeline-actions.ts"), "utf8");
const lifeForm = readFileSync(path.join(root, "src/client/life-form-helpers.ts"), "utf8");
const meProfileController = readFileSync(path.join(root, "src/client/me-profile-controller.ts"), "utf8");
const directiveLoader = readFileSync(path.join(root, "src/client/health-directives-loader-client.ts"), "utf8");
const recordsController = readFileSync(path.join(root, "src/client/me-records-health-doc-controller.ts"), "utf8");
const standScreen = readFileSync(path.join(root, "src/client/stand-screen.ts"), "utf8");

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

test("Set delete applies locally before the network round-trip and drops the full renderToday", () => {
  // The old path awaited the DELETE then rebuilt the whole surface — gone.
  assert.doesNotMatch(setActions, /await deps\.api\(`\/sets\/\$\{button\.dataset\.del\}`[\s\S]*deps\.renderToday\(\)/);
  // The chip is removed and stats re-tallied BEFORE the await; rollback re-inserts.
  const chipRemove = setActions.indexOf("chip.remove();");
  const awaitDelete = setActions.indexOf("responseRecord(await deps.api(");
  assert.ok(chipRemove > -1 && awaitDelete > chipRemove, "chip is removed locally before the DELETE await");
  assert.match(setActions, /bumpProgress\(card\);\s*\n\s*refreshFinishStat\(deps\);\s*\n\s*CairnTodaySessionSetModel\.invalidateSetTruth\(deps\)/);
  assert.match(setActions, /parent\.insertBefore\(chip, anchor\)/); // rollback restores position
});

test("Session feedback dots roll back to the prior fill when the save is rejected", () => {
  assert.match(feedbackClient, /const prevOn = dots\.map\(\(dot\) => dot\.classList\.contains\("feel-dot-on"\)\)/);
  assert.match(feedbackClient, /const ok = await save\(\)/);
  assert.match(feedbackClient, /picked\[kind\] = prevVal/);
  assert.match(feedbackClient, /dots\.forEach\(\(dot, index\) => dot\.classList\.toggle\("feel-dot-on", prevOn\[index\]\)\)/);
});

test("Today soft repaint suppresses the reveal stagger and restores scroll", () => {
  assert.match(todayScreen, /const prevY = typeof window !== "undefined" \? window\.scrollY : 0/);
  assert.match(todayScreen, /todayView\.classList\.toggle\("today-soft", !!soft\)/);
  assert.match(todayScreen, /if \(soft\) \{ try \{ window\.scrollTo\(0, prevY\); \} catch \{\} \}/);
  const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");
  assert.match(styles, /\.today-soft \.reveal\{animation:none;transform:none\}/);
});

test("Life timeline paints cached-first and mutates optimistically with rollback", () => {
  assert.match(lifeTimeline, /const LIFE_CACHE_KEY = "me:life"/);
  assert.match(lifeTimeline, /peekCached<LifeControllerContextEvent\[\]>\(LIFE_CACHE_KEY\)/);
  // Add (form helper), edit, and delete all go through optimisticMutation on the key.
  assert.match(lifeForm, /optimisticMutation<LifeControllerContextEvent\[\]>\(\{\s*\n\s*key: "me:life"/);
  assert.match(lifeTimeline, /optimisticMutation<LifeControllerContextEvent\[\]>\(\{[\s\S]*key: LIFE_CACHE_KEY[\s\S]*rollback: cachedLifeEvents\(\)/);
  assert.match(lifeTimeline, /onChange: \(\) => repaintCachedLife\(deps\)/);
  // The old await-then-full-reload path is gone from add/edit/delete.
  assert.doesNotMatch(lifeForm, /lifeFormTimelineActions\(\)\.load\(deps\)/);
});

test("Me Profile paints the SWR-cached profile before revalidating", () => {
  assert.match(meProfileController, /const peek = peekCached<MeProfileProfile>\("profile"\)/);
  assert.match(meProfileController, /if \(peek\) await applyProfile\(deps, peek\.data/);
  assert.match(meProfileController, /swrSet\("profile", profileRaw\)/);
  // A background revalidate must not stomp an open edit.
  assert.match(meProfileController, /document\.body\.classList\.contains\("savebar-open"\)/);
  const warm = meProfileController.indexOf("if (peek) await applyProfile(deps, peek.data");
  const revalidate = meProfileController.indexOf('await Promise.all([deps.api("/profile"), deps.api("/goal")])');
  assert.ok(warm > -1 && revalidate > warm, "warm cached paint precedes the network revalidation");
});

test("Stand Records/Learned/Connections paint cached-first (memory-only health keys)", () => {
  // Health surfaces stay in the memory tier — never written to disk.
  assert.match(swrCache, /\^\(markers:\|recovery:\|health:\)/);
  assert.match(standScreen, /peekCached<unknown>\("health:learned"\)/);
  assert.match(standScreen, /cachedApi\("\/learned-timeline", \{\s*\n\s*key: "health:learned"/);
  assert.match(directiveLoader, /const DIRECTIVES_CACHE_KEY = "health:directives"/);
  assert.match(directiveLoader, /peekCached<DirectiveLoaderBundle>\(DIRECTIVES_CACHE_KEY\)/);
  assert.match(directiveLoader, /swrInvalidate\(DIRECTIVES_CACHE_KEY\)/);
  assert.match(recordsController, /const RECORDS_CACHE_KEY = "health:records"/);
  assert.match(recordsController, /peekCached<HealthDocument\[\]>\(RECORDS_CACHE_KEY\)/);
  assert.match(recordsController, /swrSet\(RECORDS_CACHE_KEY, docs\)/);
});
