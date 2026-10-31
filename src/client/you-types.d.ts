// Erased declarations for the You home (v2 wave 5 stream B): the cairn-stack and the
// stone detail. Execution code lives in src/client/{cairn-stack,stone-detail}-*.ts and
// src/client/you-screen.ts; this file only names their shapes and globals.

type ClientStoneKey = import("../contracts/today-stones.js").TodayStoneKey;
type ClientStoneTone = import("../contracts/today-stones.js").TodayStoneTone;
type ClientStonesRead = import("../contracts/today-stones.js").TodayStonesRead;

/** A route the You home can open: a view, its section and (domain / stone) its id. */
type ClientYouTarget = { tab: ClientTabName; section: string | null; id?: string | null };

/** One stone as the You home shows it: the server's name, word, tone and line, verbatim. */
type ClientCairnStone = {
  key: string;
  label: string;
  word: string;
  tone: ClientStoneTone;
  line: string | null;
  /** The stone detail's link (you/stone?id=<key>), or null when none can be built. */
  href: string | null;
};
type ClientCairnStackModel = { date: string; stones: ClientCairnStone[] };

/** One of a stone's homes: where that part of the picture already lives. */
type ClientStoneHome = { key: string; title: string; sub: string; target: ClientYouTarget };
type ClientStoneHomeLink = ClientStoneHome & { href: string | null };
/** Another stone as the detail names it: its name and today's word (null until read). */
type ClientStonePeer = { key: ClientStoneKey; name: string; word: string | null };
type ClientStoneDetailModel = {
  key: ClientStoneKey;
  /** The server's stone for today, or null while it is loading or when the read failed. */
  stone: ClientCairnStone | null;
  /** The stone's own name, used only while its read is not in hand. */
  name: string;
  links: ClientStoneHomeLink[];
  /** The stones this one moves with, each with its own word. */
  peers: ClientStonePeer[];
  /** All six, for the switcher. */
  all: ClientStonePeer[];
};

type ClientYouReadDeps = {
  /** The day the read is for (`?date=`), also its SWR key. */
  date: string;
  peek(key: string): { data: ClientStonesRead; fresh: boolean } | null;
  load(path: string, options: { key: string }): Promise<ClientStonesRead>;
  reducedMotion(): boolean;
  hrefFor?(target: ClientYouTarget): string | null;
};
type ClientCairnStackDeps = ClientYouReadDeps & {
  /** Open one stone's detail. */
  openStone(key: string): void;
};
type ClientStoneDetailDeps = ClientYouReadDeps & {
  stone: string;
  /** Open one of the stone's homes. */
  navigate(target: ClientYouTarget): void;
  /** Step back to the You landing. */
  back(): void;
  /** The page header's title follows the model's name (one source for the stone's name). */
  setTitle?(name: string): void;
};

interface Window {
  CairnStackModel: {
    KEY_PREFIX: string;
    keyFor(date: string): string;
    pathFor(date: string): string;
    stoneTarget(key: string): ClientYouTarget;
    model(
      read: Partial<ClientStonesRead> | null | undefined,
      opts?: { hrefFor?: (target: ClientYouTarget) => string | null }
    ): ClientCairnStackModel | null;
  };
  CairnStack: {
    html(model: ClientCairnStackModel | null, opts?: { enter?: boolean }): string;
    skeletonHtml(): string;
  };
  CairnStackController: {
    mount(host: Element, deps: ClientCairnStackDeps): () => void;
  };
  CairnStoneDetailModel: {
    STONE_HOMES: Readonly<Record<ClientStoneKey, readonly ClientStoneHome[]>>;
    isStone(key: unknown): key is ClientStoneKey;
    model(
      key: string,
      read: Partial<ClientStonesRead> | null | undefined,
      opts?: { hrefFor?: (target: ClientYouTarget) => string | null }
    ): ClientStoneDetailModel | null;
  };
  CairnStoneDetail: {
    html(model: ClientStoneDetailModel, opts?: { enter?: boolean; loading?: boolean }): string;
  };
  CairnStoneDetailController: {
    mount(host: Element, deps: ClientStoneDetailDeps): () => void;
  };
  CairnYouData: {
    /** The SWR key: `health:`, so memory-only like every health read. */
    KEY: string;
    PATH: "/health/data-coverage";
    html(read: unknown, opts?: { relTime?: (iso: string) => string }): string;
    skeletonHtml(): string;
    addSheetHtml(): string;
    whenWords(row: ClientDataCoverageRow, relTime?: (iso: string) => string): string;
    normalize(read: unknown): { rows: ClientDataCoverageRow[]; gaps: ClientDataCoverageGap[] } | null;
  };
  CairnYouDataController: {
    mount(host: Element, deps: ClientYouDataDeps): () => void;
    openAddSheet(deps: ClientYouDataDeps): void;
  };
}

type ClientDataCoverageRead = import("../contracts/data-coverage.js").DataCoverageRead;
type ClientDataCoverageRow = import("../contracts/data-coverage.js").DataCoverageRow;
type ClientDataCoverageGap = import("../contracts/data-coverage.js").DataCoverageGap;
type ClientYouDataDeps = {
  peek(key: string): { data: ClientDataCoverageRead; fresh: boolean } | null;
  load(path: "/health/data-coverage", options: { key: string }): Promise<ClientDataCoverageRead>;
  /** "2h ago" for a sync stamp (date-utils relTime). */
  relTime?(iso: string): string;
  /** Open the screen a source lives on. */
  openRow(row: ClientDataCoverageRow): void;
  /** Follow a gap's link (checkup, Sources); an "add" gap opens the Add sheet instead. */
  openGap(gap: ClientDataCoverageGap): void;
  /** Hand picked or dropped files to Records' own upload. */
  addFiles(files: File[]): void;
  /** Open Records with its text field ready for a paste. */
  addPaste(): void;
  openSources(): void;
};
declare const CairnStackModel: Window["CairnStackModel"];
declare const CairnStack: Window["CairnStack"];
declare const CairnStackController: Window["CairnStackController"];
declare const CairnStoneDetailModel: Window["CairnStoneDetailModel"];
declare const CairnStoneDetail: Window["CairnStoneDetail"];
declare const CairnStoneDetailController: Window["CairnStoneDetailController"];
declare const CairnYouData: Window["CairnYouData"];
declare const CairnYouDataController: Window["CairnYouDataController"];
