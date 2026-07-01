// @ts-check
// Stateful fuel-context helper for the Chat surface.

type ChatFuelDayIntake = import("../contracts/client.js").ClientDayIntake;
type ChatFuelLoadDeps = {
  currentToken(): number;
  currentTab(): string | undefined;
  openFoodReview(): void;
};
type ChatFuelContextApi = {
  clear(): void;
  current(): ChatScreenMessage[];
  seed(messages: Partial<ChatScreenMessage>[]): ChatScreenMessage[];
  remember(...msgs: Array<Partial<ChatScreenMessage> | null | undefined>): ChatScreenMessage[];
  messageHasFoodAction(message: Partial<ChatScreenMessage> | null | undefined): boolean;
  userMessageSuggestsFood(message: Partial<ChatScreenMessage> | null | undefined): boolean;
  wants(messages?: Partial<ChatScreenMessage>[]): boolean;
  html(day: ChatFuelDayIntake | null | undefined): string;
  load(token: number, messages: Partial<ChatScreenMessage>[] | undefined, deps: ChatFuelLoadDeps): Promise<void>;
};

let chatFuelContextMessages: ChatScreenMessage[] = [];

function chatFuelRows(messages: Partial<ChatScreenMessage>[]): ChatScreenMessage[] {
  return messages.filter((msg): msg is ChatScreenMessage => !!msg && typeof msg === "object");
}

function clearChatFuelContext(): void {
  chatFuelContextMessages = [];
}

function currentChatFuelContext(): ChatScreenMessage[] {
  return chatFuelContextMessages;
}

function seedChatFuelContext(messages: Partial<ChatScreenMessage>[]): ChatScreenMessage[] {
  chatFuelContextMessages = chatFuelRows(messages).slice(-24);
  return chatFuelContextMessages;
}

function rememberChatFuelContextValue(...msgs: Array<Partial<ChatScreenMessage> | null | undefined>): ChatScreenMessage[] {
  const next = [...chatFuelContextMessages, ...msgs.filter((msg): msg is ChatScreenMessage => !!msg && typeof msg === "object")];
  chatFuelContextMessages = next.slice(-24);
  return chatFuelContextMessages;
}

function chatFuelMessageHasFoodAction(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return CairnChatClient.messageHasFoodAction(m);
}

function chatFuelUserMessageSuggestsFood(m: Partial<ChatScreenMessage> | null | undefined): boolean {
  return CairnChatClient.userMessageSuggestsFood(m);
}

function chatFuelWantsSurface(messages: Partial<ChatScreenMessage>[] = chatFuelContextMessages): boolean {
  return CairnChatClient.wantsFuelSurface(messages, { todayISO: localISO(), dayISO: chatDayISO });
}

function chatFuelSurfaceHtml(d: ChatFuelDayIntake | null | undefined): string {
  return CairnChatClient.fuelHtml(d);
}

async function loadChatFuelContext(
  token: number,
  messages: Partial<ChatScreenMessage>[] | undefined,
  deps: ChatFuelLoadDeps,
): Promise<void> {
  const slot = $("#chatFuelSlot");
  if (!slot) return;
  if (!chatFuelWantsSurface(messages || chatFuelContextMessages)) { slot.innerHTML = ""; return; }
  let d: ChatFuelDayIntake | null = null;
  try { d = await api("/nutrition/day"); } catch { slot.innerHTML = ""; return; }
  if (token !== deps.currentToken() || deps.currentTab() !== "chat" || !slot.isConnected) return;
  slot.innerHTML = chatFuelSurfaceHtml(d);
  const card = slot.querySelector("#chatFuelCard");
  if (card) card.addEventListener("click", deps.openFoodReview);
}

const CAIRN_CHAT_FUEL_CONTEXT: ChatFuelContextApi = {
  clear: clearChatFuelContext,
  current: currentChatFuelContext,
  seed: seedChatFuelContext,
  remember: rememberChatFuelContextValue,
  messageHasFoodAction: chatFuelMessageHasFoodAction,
  userMessageSuggestsFood: chatFuelUserMessageSuggestsFood,
  wants: chatFuelWantsSurface,
  html: chatFuelSurfaceHtml,
  load: loadChatFuelContext,
};

Object.assign(globalThis, { CairnChatFuelContext: CAIRN_CHAT_FUEL_CONTEXT });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnChatFuelContext: CAIRN_CHAT_FUEL_CONTEXT });
}
