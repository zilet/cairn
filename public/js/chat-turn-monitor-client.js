(() => {
// @ts-check
// Durable chat-turn EventSource monitor. Owns stream lifecycle and per-event
// dispatch; the chat turn client owns DOM bubbles and final rendering.
function createChatTurnMonitor(deps) {
    let stream = null;
    let streamId = null;
    function closeSource(source) {
        if (!source)
            return;
        try {
            source.close();
        }
        catch { }
    }
    function close() {
        const source = stream;
        stream = null;
        streamId = null;
        closeSource(source);
    }
    function closeFor(source) {
        if (stream === source)
            close();
        else
            closeSource(source);
    }
    function guard(source) {
        if (deps.isActive() && deps.hasLog())
            return false;
        closeFor(source);
        return true;
    }
    function ensure() {
        if (stream || !deps.isActive())
            return;
        const ids = deps.pendingIds()
            .filter((id) => Number.isFinite(id))
            .sort((a, b) => a - b);
        if (!ids.length)
            return;
        open(ids[0]);
    }
    function terminal(source) {
        closeFor(source);
        ensure();
    }
    function eventRow(event) {
        return deps.parse(event);
    }
    function rowTurn(row) {
        return deps.record(row.turn);
    }
    function isTerminalStatus(status) {
        return ["done", "error", "canceled"].includes(String(status || ""));
    }
    function open(id) {
        if (stream)
            return;
        streamId = id;
        let source = null;
        try {
            source = deps.createStream(id);
        }
        catch {
            streamId = null;
            return;
        }
        if (!source) {
            streamId = null;
            return;
        }
        stream = source;
        source.addEventListener("snapshot", (event) => {
            if (guard(source))
                return;
            const row = eventRow(event);
            if (!row)
                return;
            const turn = rowTurn(row);
            const status = turn.status;
            if (isTerminalStatus(status)) {
                if (status === "canceled")
                    deps.cancel(turn);
                else
                    deps.finish(turn, row.message);
                terminal(source);
                return;
            }
            deps.phase(id, row.turn || row);
        });
        source.addEventListener("phase", (event) => {
            if (guard(source))
                return;
            const row = eventRow(event);
            deps.phase(id, row?.turn);
        });
        source.addEventListener("progress", (event) => {
            if (guard(source))
                return;
            deps.progress(id, eventRow(event)?.text);
        });
        source.addEventListener("delta", (event) => {
            if (guard(source))
                return;
            deps.delta(id, eventRow(event)?.text);
        });
        source.addEventListener("reset", () => {
            if (!guard(source))
                deps.reset(id);
        });
        source.addEventListener("done", (event) => {
            if (guard(source))
                return;
            const row = eventRow(event);
            if (!row)
                return;
            deps.finish(row.turn, row.message);
            terminal(source);
        });
        source.addEventListener("canceled", (event) => {
            if (guard(source))
                return;
            deps.cancel(eventRow(event)?.turn);
            terminal(source);
        });
        source.addEventListener("error", (event) => {
            const data = event.data;
            if (!data)
                return;
            if (guard(source))
                return;
            const row = eventRow(event);
            if (!row)
                return;
            deps.finish(row.turn, row.message);
            terminal(source);
        });
    }
    return {
        close,
        currentId: () => streamId,
        ensure,
        open,
    };
}
const CAIRN_CHAT_TURN_MONITOR = {
    create: createChatTurnMonitor,
};
Object.assign(globalThis, { CairnChatTurnMonitor: CAIRN_CHAT_TURN_MONITOR });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnChatTurnMonitor: CAIRN_CHAT_TURN_MONITOR });
}
})();
