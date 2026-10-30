// @ts-check
// The stone detail (docs/V2-PLAN.md wave 5, `stone-detail`; /app/you/stone?id=<key>),
// the model. One stone's read, then the places that part of the picture already lives
// ("its homes"). The read is the server's stone from GET /api/today/stones, carried
// verbatim through the cairn-stack model; this module adds only navigation, never a
// word about how the stone is doing.
//
// The decade view (Health → Age, "How you compare") is reachable from Heart's homes
// and nowhere else in the You home.
{
  type Target = ClientYouTarget;

  const home = (key: string, title: string, sub: string, target: Target): ClientStoneHome => ({
    key,
    title,
    sub,
    target,
  });

  // Each stone's homes, in the order they are offered. Titles are the surfaces' own
  // names; the targets are views the router already knows (the shell maps each onto
  // its home: plan/edit → Train, plan/endurance → Horizon, plan/food → Today).
  const STONE_HOMES: Readonly<Record<ClientStoneKey, readonly ClientStoneHome[]>> = {
    strength: [
      home("overview", "Train", "How your lifts are moving", { tab: "progress", section: "overview" }),
      home("plan", "Plan", "The program you are running", { tab: "plan", section: "edit" }),
    ],
    endurance: [
      home("race", "Race", "Your race build, week by week", { tab: "plan", section: "endurance" }),
      home("runs", "Endurance", "Your runs and what they add up to", { tab: "progress", section: "endurance" }),
    ],
    fuel: [
      home("intake", "Intake", "Today's food so far, then the weeks before it", { tab: "progress", section: "intake" }),
      home("energy", "Energy", "What you burn, read from your own log", { tab: "progress", section: "energy" }),
    ],
    recovery: [
      home("recovery", "Recovery", "Sleep, heart rate and readiness in plain words", {
        tab: "stand",
        section: "recovery",
      }),
    ],
    body: [
      home("body", "Body", "Scans and body composition", { tab: "stand", section: "body" }),
      home("weight", "Weight", "Your bodyweight over time", { tab: "progress", section: "weight" }),
      home("measurements", "Measurements", "Tape measurements over time", {
        tab: "progress",
        section: "measurements",
      }),
    ],
    heart: [
      home("health", "Health", "Where you stand, across every marker", { tab: "stand", section: null }),
      home("domain", "Heart and circulation", "Lipids, blood pressure and the markers around them", {
        tab: "stand",
        section: "domain",
        id: "heart",
      }),
      home("age", "Across the decades", "How you compare with people your age", { tab: "stand", section: "age" }),
    ],
  };

  // A stone's own name, used only until its read is in hand (the read carries the
  // server's label, which always wins).
  const NAMES: Readonly<Record<ClientStoneKey, string>> = {
    strength: "Strength",
    endurance: "Endurance",
    fuel: "Fuel",
    recovery: "Recovery",
    body: "Body",
    heart: "Heart",
  };

  // What each stone moves with: the connected picture, read the same way every day.
  // Only the order and the pairing live here; each peer speaks its own server word.
  const PEERS: Readonly<Record<ClientStoneKey, readonly ClientStoneKey[]>> = {
    strength: ["recovery", "fuel", "body"],
    endurance: ["recovery", "fuel", "heart"],
    fuel: ["body", "strength", "endurance"],
    recovery: ["strength", "endurance", "heart"],
    body: ["fuel", "heart", "strength"],
    heart: ["body", "endurance", "fuel"],
  };

  /** The six in the server's order, for the switcher. */
  const ORDER: readonly ClientStoneKey[] = ["strength", "endurance", "fuel", "recovery", "body", "heart"];

  function isStone(key: unknown): key is ClientStoneKey {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(STONE_HOMES, key);
  }

  /** The detail's view model; null for a key that is not one of the six stones. */
  function stoneDetailModel(
    key: string,
    read: Partial<ClientStonesRead> | null | undefined,
    opts: { hrefFor?: (target: Target) => string | null } = {}
  ): ClientStoneDetailModel | null {
    if (!isStone(key)) return null;
    const stack = CairnStackModel.model(read);
    const stone = stack?.stones.find((s) => s.key === key) || null;
    const links = STONE_HOMES[key].map((h) => {
      let href: string | null = null;
      if (opts.hrefFor) {
        try {
          href = opts.hrefFor(h.target) || null;
        } catch {
          href = null;
        }
      }
      return { ...h, href };
    });
    const peerOf = (peer: ClientStoneKey): ClientStonePeer => {
      const found = stack?.stones.find((s) => s.key === peer) || null;
      return { key: peer, name: found ? found.label : NAMES[peer], word: found ? found.word : null };
    };
    return {
      key,
      stone,
      name: stone ? stone.label : NAMES[key],
      links,
      peers: PEERS[key].map(peerOf),
      all: ORDER.map(peerOf),
    };
  }

  const CAIRN_STONE_DETAIL_MODEL: Window["CairnStoneDetailModel"] = {
    STONE_HOMES,
    isStone,
    model: stoneDetailModel,
  };

  Object.assign(globalThis, { CairnStoneDetailModel: CAIRN_STONE_DETAIL_MODEL });
}
