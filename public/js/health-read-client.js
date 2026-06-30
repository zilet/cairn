// @ts-check
// Pure Health Read rail renderers for recovery and priority markers.
(() => {
    function recoveryNoDataHtml(message = "No sleep or recovery signal yet. Connect a wearable, or jot how you're feeling, and the buddy will fold it into your day.") {
        return `<div class="hb-recovery hb-recovery-empty reveal" style="${stagger(0)}">
        <span class="lbl">Recovery</span>
        <p class="hb-recovery-hint">${escHtml(message)}</p>
      </div>`;
    }
    function recoveryLineHtml(text, sub) {
        return `<div class="hb-rline"><span class="hb-rphrase">${escHtml(text)}</span>${sub ? `<span class="hb-rsub">${escHtml(sub)}</span>` : ""}</div>`;
    }
    // Plain-language recovery summary. Each row is a phrase, not a number to interpret.
    function recoveryHtml(summary) {
        const recovery = summary?.recovery || {};
        const lines = [];
        const sleepMinutes = Number(recovery.avg_sleep_min);
        if (Number.isFinite(sleepMinutes) && sleepMinutes > 0) {
            const hours = Math.floor(sleepMinutes / 60);
            const minutes = Math.round(sleepMinutes % 60);
            const sleepHours = sleepMinutes / 60;
            const phrase = sleepHours >= 7.5 ? "Sleeping well" :
                sleepHours >= 6.5 ? "Sleep's about right" :
                    sleepHours >= 5.5 ? "Sleep's run a little short" :
                        "Sleep's been short";
            const deep = Number(recovery.avg_deep_sleep_min);
            const rem = Number(recovery.avg_rem_sleep_min);
            const architecture = [
                Number.isFinite(deep) && deep > 0 ? `${Math.round(deep)}m deep` : null,
                Number.isFinite(rem) && rem > 0 ? `${Math.round(rem)}m REM` : null,
            ].filter(Boolean).join(" · ");
            lines.push(recoveryLineHtml(phrase, `${hours}h${minutes ? " " + minutes + "m" : ""} a night${architecture ? " · " + architecture : ""}`));
        }
        const restingHr = Number(recovery.avg_resting_hr);
        if (Number.isFinite(restingHr) && restingHr > 0) {
            lines.push(recoveryLineHtml("Resting heart rate steady", `~${Math.round(restingHr)} bpm`));
        }
        const hrv = Number(recovery.avg_hrv_ms);
        if (Number.isFinite(hrv) && hrv > 0) {
            const status = String(recovery.hrv_status || "").toLowerCase();
            const phrase = status === "balanced" ? "Heart-rate variability balanced" :
                status === "unbalanced" ? "Heart-rate variability a touch off" :
                    status === "low" || status === "poor" ? "Heart-rate variability running low" :
                        "Heart-rate variability holding";
            lines.push(recoveryLineHtml(phrase, `~${Math.round(hrv)} ms`));
        }
        const stress = Number(recovery.avg_stress);
        if (Number.isFinite(stress) && stress > 0) {
            const phrase = stress < 26 ? "Stress load's low" : stress < 51 ? "Stress load's moderate" : "Stress load's run high";
            lines.push(recoveryLineHtml(phrase, ""));
        }
        const bodyBattery = Number(recovery.avg_body_battery);
        if (Number.isFinite(bodyBattery) && bodyBattery > 0) {
            const phrase = bodyBattery >= 60 ? "Energy reserves look good" : bodyBattery >= 40 ? "Energy reserves middling" : "Running a bit low on reserves";
            lines.push(recoveryLineHtml(phrase, ""));
        }
        const respiration = Number(recovery.avg_respiration);
        const spo2 = Number(recovery.avg_spo2);
        if ((Number.isFinite(respiration) && respiration > 0) || (Number.isFinite(spo2) && spo2 > 0)) {
            const sub = [
                Number.isFinite(respiration) && respiration > 0 ? `~${Math.round(respiration)}/min` : null,
                Number.isFinite(spo2) && spo2 > 0 ? `SpO₂ ${Math.round(spo2)}%` : null,
            ].filter(Boolean).join(" · ");
            const phrase = Number.isFinite(spo2) && spo2 > 0 && spo2 < 93 ? "Blood oxygen ran low overnight" : "Breathing steady overnight";
            lines.push(recoveryLineHtml(phrase, sub));
        }
        const skinTemp = Number(recovery.skin_temp_dev_c);
        if (Number.isFinite(skinTemp) && Math.abs(skinTemp) >= 0.3) {
            lines.push(recoveryLineHtml(skinTemp > 0 ? "Skin temp ran warm overnight" : "Skin temp ran cool overnight", `${skinTemp > 0 ? "+" : ""}${skinTemp}°C vs baseline`));
        }
        const trainingReadiness = Number(recovery.avg_training_readiness);
        if (Number.isFinite(trainingReadiness) && trainingReadiness > 0) {
            const phrase = trainingReadiness >= 75 ? "Primed to train" :
                trainingReadiness >= 50 ? "Ready for a normal day" :
                    trainingReadiness >= 25 ? "Ease in — recovery's partial" :
                        "Body's asking for a lighter day";
            lines.push(recoveryLineHtml(phrase, ""));
        }
        const vo2max = Number(recovery.vo2max);
        if (Number.isFinite(vo2max) && vo2max > 0) {
            const status = String(recovery.training_status || "").replace(/_/g, " ").toLowerCase();
            lines.push(recoveryLineHtml("Aerobic fitness", `VO₂max ~${Math.round(vo2max)}${status ? " · " + status : ""}`));
        }
        const steps = Number(recovery.avg_steps);
        if (Number.isFinite(steps) && steps > 0) {
            const phrase = steps >= 8000 ? "Moving plenty day to day" : steps >= 4000 ? "Moving a fair bit" : "Fairly sedentary lately";
            lines.push(recoveryLineHtml(phrase, `~${fmtK(steps)} steps`));
        }
        const weightKg = Number(recovery.weight_kg);
        const bodyFatPct = Number(recovery.body_fat_pct);
        const muscleMassKg = Number(recovery.muscle_mass_kg);
        if ((Number.isFinite(weightKg) && weightKg > 0) || (Number.isFinite(bodyFatPct) && bodyFatPct > 0)) {
            const sub = [
                Number.isFinite(weightKg) && weightKg > 0 ? `${Math.round(weightKg * 10) / 10} kg` : null,
                Number.isFinite(bodyFatPct) && bodyFatPct > 0 ? `${Math.round(bodyFatPct * 10) / 10}% fat` : null,
                Number.isFinite(muscleMassKg) && muscleMassKg > 0 ? `${Math.round(muscleMassKg * 10) / 10} kg muscle` : null,
            ].filter(Boolean).join(" · ");
            lines.push(recoveryLineHtml("Body composition", sub));
        }
        if (!lines.length) {
            return recoveryNoDataHtml("Recovery data's coming in but nothing to call out yet.");
        }
        const sourceLabel = (Array.isArray(summary?.sources) ? summary.sources : [])
            .map((source) => source === "garmin" ? "Garmin" : source === "apple" ? "Apple Health" : source)
            .filter(Boolean)
            .join(" · ");
        return `<div class="hb-recovery reveal" style="${stagger(0)}">
    <div class="hb-rtop"><span class="lbl">Recovery · last 2 weeks</span>${sourceLabel ? `<span class="hb-rsrc">${escHtml(sourceLabel)}</span>` : ""}</div>
    <div class="hb-rlist">${lines.join("")}</div>
  </div>`;
    }
    function optimalPhrase(marker) {
        const optimal = marker?.optimal;
        const latest = marker?.latest || {};
        const flag = String(latest.flag || "").toLowerCase();
        if (!optimal) {
            if (flag === "high")
                return { word: "running high", tone: "warn" };
            if (flag === "low")
                return { word: "running low", tone: "warn" };
            if (flag === "normal" || flag === "ok")
                return { word: "in range", tone: "ok" };
            return { word: "worth a look", tone: "watch" };
        }
        if (marker?.in_optimal === true)
            return { word: "in your optimal range", tone: "ok" };
        if (marker?.in_optimal === false) {
            const value = Number(latest.value);
            if (Number.isFinite(value)) {
                if (value > Number(optimal.high))
                    return { word: "above optimal", tone: "warn" };
                if (value < Number(optimal.low))
                    return { word: "below optimal", tone: "warn" };
            }
            if (optimal.dir === "low")
                return { word: "below optimal", tone: "warn" };
            if (optimal.dir === "high")
                return { word: "above optimal", tone: "warn" };
            return { word: "outside your optimal range", tone: "warn" };
        }
        return { word: "worth a look", tone: "watch" };
    }
    function priorityMarkerHtml(marker, index) {
        const latest = marker?.latest || {};
        const phrase = optimalPhrase(marker);
        const dotClass = phrase.tone === "ok" ? "hdot-ok" : phrase.tone === "warn" ? "hdot-warn" : "hdot-watch";
        const value = latest.value != null && latest.value !== "" ? CairnHealthClient.formatMarkerNumber(latest.value) : "";
        const valueLine = value
            ? `<span class="hb-mkval">${escHtml(value)}${marker?.unit ? `<span class="hmk-unit">${escHtml(marker.unit)}</span>` : ""}</span>`
            : "";
        const points = (Array.isArray(marker?.points) ? marker.points : []).filter((point) => point && Number.isFinite(Number(point.value)));
        const trend = points.length >= 2 ? `<div class="hb-mktrend">${sparklineSvg(points.map((point) => Number(point.value)))}</div>` : "";
        const bandNote = marker?.optimal
            ? `<span class="hb-mkband">optimal ${escHtml(CairnHealthClient.formatMarkerNumber(marker.optimal.low))}–${escHtml(CairnHealthClient.formatMarkerNumber(marker.optimal.high))}${marker.unit ? " " + escHtml(marker.unit) : ""}</span>`
            : "";
        const when = latest.date ? `<span class="hb-mkwhen" title="${escAttr(absDate(String(latest.date)))}">${escHtml(relAge(String(latest.date)))}</span>` : "";
        return `<div class="hb-mk reveal" style="${stagger(index)}">
    <div class="hb-mktop">
      <span class="hdot ${dotClass}"></span>
      <span class="hb-mkname">${escHtml(marker?.name || marker?.key || "")}</span>
      <span class="hb-mkphrase hb-mkphrase-${phrase.tone}">${escHtml(phrase.word)}</span>
      <span class="hb-mkright">${valueLine}</span>
    </div>
    ${bandNote || when ? `<div class="hb-mkmeta">${bandNote}${bandNote && when ? `<span class="hb-mkdot">·</span>` : ""}${when}</div>` : ""}
    ${trend}
  </div>`;
    }
    function priorityMarkersSectionHtml(markersInput) {
        const markers = Array.isArray(markersInput) ? markersInput.filter((marker) => !!marker && typeof marker === "object") : [];
        if (!markers.length) {
            return `<div class="hb-section">
        <div class="hb-sechead"><span class="lbl">What matters now</span></div>
        <div class="empty">No markers yet. Add a lab report on the Records tab and Cairn pulls out what matters most.</div>
      </div>`;
        }
        const matters = markers.filter((marker) => optimalPhrase(marker).tone !== "ok");
        const good = markers.filter((marker) => optimalPhrase(marker).tone === "ok");
        const lead = (matters.length ? matters : markers).slice(0, 4);
        const rest = matters.length ? matters.slice(4).concat(good) : markers.slice(4);
        return `<div class="hb-section">
      <div class="hb-sechead"><span class="lbl">What matters now</span>${matters.length ? `<span class="hb-secnote">${matters.length} to keep an eye on</span>` : `<span class="hb-secnote">all looking good</span>`}</div>
      <div class="hb-mklist">${lead.map((marker, index) => priorityMarkerHtml(marker, index)).join("")}</div>
      ${rest.length ? `<details class="hb-more"><summary>Everything else (${rest.length})</summary><div class="hb-mklist hb-mklist-quiet">${rest.map((marker, index) => priorityMarkerHtml(marker, index)).join("")}</div></details>` : ""}
      <button class="hb-mk-allbtn" id="hbToMarkers" type="button">See every trend →</button>
    </div>`;
    }
    const CAIRN_HEALTH_READ = {
        recoveryNoDataHtml,
        recoveryLineHtml,
        recoveryHtml,
        optimalPhrase,
        priorityMarkerHtml,
        priorityMarkersSectionHtml,
    };
    Object.assign(globalThis, { CairnHealthRead: CAIRN_HEALTH_READ });
    if (typeof window !== "undefined") {
        window.CairnHealthRead = CAIRN_HEALTH_READ;
    }
})();
