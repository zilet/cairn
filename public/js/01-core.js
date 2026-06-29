// ==== 01-core.js ====
const $ = (s) => document.querySelector(s);
const view = $("#view");
const headerTitle = $("#header-title");

const state = { tab: "today", day: null, dayPicked: false, plan: [], today: {}, logDate: localISO() };
