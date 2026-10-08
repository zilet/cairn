// The marker row as it crosses the REST/MCP boundary — the ONE projection the Records
// page (GET /api/markers/priority), the get_priority_markers MCP tool and the records
// search (`marker` on a hit) all hand out.
//
//   - Internal ordering signals never leave: `impact_score` (already stripped by
//     prioritizeMarkers) and `distance`, the optimal-distance number it is built from.
//     Both stay available in-process to the engines that rank with them.
//   - The optimal fields are cleared where the band is not trustworthy for this marker
//     (`optimalTrustworthy`, src/repo/optimal-trust.ts — the guard the doctor packet and
//     evidence-wanted apply), so a row's "outside optimal" mark and the packet agree.
//   - "Out of range" per the LAB arrives finished (`lab_range`, `lab_out_of_range`,
//     `lab_out_of_range_side`, src/repo/lab-range.ts), so no renderer re-derives it.
//   - Values arrive in the athlete's lab-unit system (src/repo/lab-display.ts), converted
//     only AFTER every read above was made in the canonical unit.
//
// The lab's range and the optimal band stay two separate facts on the row.

import { optimalTrustworthy } from "../../repo/optimal-trust.js";
import { labRangeFields } from "../../repo/lab-range.js";
import { wearableWeeklyMarkerRead } from "../../repo/health-focus.js";
import { prioritizeMarkers } from "../../repo/propagation.js";
import { presentMarkerRow } from "../../repo/lab-display.js";
import { labUnitSystem } from "../../repo/settings.js";
import type { LabUnitSystem } from "../../repo/lab-units.js";

/** Whether this row's optimal band is one the surfaces may speak about. */
export function markerOptimalTrusted(m: any): boolean {
  const band = m?.optimal;
  const hasBand = !!band && Number.isFinite(Number(band.low)) && Number.isFinite(Number(band.high));
  return hasBand && optimalTrustworthy(String(m?.name ?? m?.key ?? ""), m?.latest?.value);
}

export function publicMarkerRow(m: any, system: LabUnitSystem = labUnitSystem()): Record<string, unknown> {
  const { impact_score: _impact, distance: _distance, ...rest } = m ?? {};
  const trusted = markerOptimalTrusted(m);
  return presentMarkerRow(
    {
      ...rest,
      ...(trusted ? {} : { optimal: null, in_optimal: null }),
      ...labRangeFields(m),
    },
    system
  );
}

// The priority-marker catalog as both surfaces hand it out (GET /api/markers/priority
// and the get_priority_markers MCP tool). HRV / Resting HR are re-judged on the same
// week the directive engine reads (wearableWeeklyMarkerRead, health-focus.ts), then
// every row goes through publicMarkerRow.
export function publicPriorityMarkers(): Record<string, unknown> & { markers: Record<string, unknown>[] } {
  const priority = prioritizeMarkers() as any;
  const system = labUnitSystem();
  return {
    ...priority,
    unit_system: system,
    markers: (priority.markers ?? []).map((m: any) => publicMarkerRow(wearableWeeklyMarkerRead(m), system)),
  };
}
