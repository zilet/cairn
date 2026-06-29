import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpToolRegistrar = Pick<McpServer, "tool">;

export function asText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}
