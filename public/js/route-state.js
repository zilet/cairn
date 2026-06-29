(function initCairnRoutes(root) {
    const VALID_TABS = new Set(["today", "plan", "progress", "chat", "me", "settings"]);
    const PLAN_SECTIONS = new Set(["edit", "endurance", "food", "meals", "coach"]);
    const PROGRESS_SECTIONS = new Set(["trend", "volume", "endurance", "weight", "calendar", "sessions", "program", "energy"]);
    const ME_SECTIONS = new Set(["standing", "profile", "memory", "health", "life", "family"]);
    const HEALTH_SECTIONS = new Set(["read", "markers", "records", "share", "learned"]);
    const SETTINGS_SECTIONS = new Set(["agents", "sources", "automation", "data"]);
    function cleanSegment(v) {
        return String(v || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
    }
    function firstParam(params, key) {
        const v = params.get(key);
        return v == null || v === "" ? null : v;
    }
    function validDate(v) {
        const s = String(v || "").trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    }
    function oneOf(value, allowed, fallback = null) {
        const v = cleanSegment(value);
        return allowed.has(v) ? v : fallback;
    }
    function toUrl(input) {
        try {
            if (input instanceof URL)
                return input;
            return new URL(String(input || "/"), "http://cairn.local");
        }
        catch {
            return new URL("/", "http://cairn.local");
        }
    }
    function parseRoute(input) {
        const url = toUrl(input);
        const params = url.searchParams;
        const parts = url.pathname.split("/").filter(Boolean).map(cleanSegment);
        let tab = "today";
        let section = null;
        let healthSection = null;
        if (parts[0] === "app")
            tab = oneOf(parts[1], VALID_TABS, "today") || "today";
        else if (VALID_TABS.has(parts[0]))
            tab = parts[0];
        else
            tab = oneOf(firstParam(params, "tab"), VALID_TABS, "today") || "today";
        const route = {
            tab,
            section: null,
            healthSection: null,
            date: validDate(firstParam(params, "date")),
            id: firstParam(params, "id"),
            session: firstParam(params, "session"),
            jump: firstParam(params, "jump"),
        };
        const sectionPart = parts[0] === "app" ? parts[2] : parts[1];
        const nestedPart = parts[0] === "app" ? parts[3] : parts[2];
        if (tab === "plan") {
            section = oneOf(sectionPart, PLAN_SECTIONS, null) || oneOf(route.jump, PLAN_SECTIONS, null);
        }
        else if (tab === "progress") {
            section = oneOf(sectionPart, PROGRESS_SECTIONS, null);
        }
        else if (tab === "me") {
            section = oneOf(sectionPart, ME_SECTIONS, "standing");
            if (section === "health") {
                healthSection = oneOf(nestedPart, HEALTH_SECTIONS, null) || oneOf(firstParam(params, "health"), HEALTH_SECTIONS, "read");
            }
        }
        else if (tab === "settings") {
            section = oneOf(sectionPart, SETTINGS_SECTIONS, null);
        }
        route.section = section;
        route.healthSection = healthSection;
        return route;
    }
    function addParam(params, key, value) {
        if (value != null && String(value).trim() !== "")
            params.set(key, String(value));
    }
    function routeToUrl(route) {
        const r = route || {};
        const tab = oneOf(r.tab, VALID_TABS, "today") || "today";
        const params = new URLSearchParams();
        let path = `/app/${tab}`;
        if (tab === "plan") {
            const section = oneOf(r.section, PLAN_SECTIONS, null);
            if (section)
                path += `/${section}`;
        }
        else if (tab === "progress") {
            const section = oneOf(r.section, PROGRESS_SECTIONS, null);
            if (section)
                path += `/${section}`;
        }
        else if (tab === "me") {
            const section = oneOf(r.section, ME_SECTIONS, null);
            if (section)
                path += `/${section}`;
            if (section === "health") {
                const h = oneOf(r.healthSection, HEALTH_SECTIONS, null);
                if (h)
                    path += `/${h}`;
            }
        }
        else if (tab === "settings") {
            const section = oneOf(r.section, SETTINGS_SECTIONS, null);
            if (section)
                path += `/${section}`;
        }
        addParam(params, "date", validDate(r.date));
        addParam(params, "id", r.id);
        addParam(params, "session", r.session);
        addParam(params, "jump", oneOf(r.jump, PLAN_SECTIONS, null));
        const q = params.toString();
        return q ? `${path}?${q}` : path;
    }
    root.CairnRoutes = {
        parseRoute,
        routeToUrl,
        validTabs: [...VALID_TABS],
        planSections: [...PLAN_SECTIONS],
        progressSections: [...PROGRESS_SECTIONS],
        meSections: [...ME_SECTIONS],
        healthSections: [...HEALTH_SECTIONS],
        settingsSections: [...SETTINGS_SECTIONS],
    };
})((typeof window !== "undefined" ? window : globalThis));
