// How a lift RESPONDS to the loading it is given — the read that lets progression pick
// the right next move for a stalled lift instead of one default. The first question it
// will answer: is this lift's next load step too coarse for it (an isolation stack whose
// smallest jump is a large fraction of the working weight), so that a stall calls for a
// higher rep range at the same weight rather than a deload.
//
// Consumed by progression.ts. Must never: write to the plan itself, change what counts
// as a stall, or move a barbell compound off its deload ladder.
export {};
