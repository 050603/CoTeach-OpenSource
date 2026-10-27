import { STATIC_MONACO_ROUTE } from "./action-entry-timing";

export type HttpOperation = "read" | "write" | "projection" | "resource" | "realtime" | "ai-interactive" | "ai-background" | "probe";

/** The route is the fixed route template supplied by a handler, never a URL
 * containing identities. AI can explicitly select its operation at the route
 * boundary without reading or cloning a potentially large request body here.
 */
export function httpOperation(method: string, route: string, status: number): HttpOperation {
  if (route.startsWith("/api/health/") || route === "/api/metrics") return "probe";
  if (route === STATIC_MONACO_ROUTE || route.startsWith("/api/uploads") || route.includes("/interactive-runtime/") || route.includes("/classroom-media/")) return "resource";
  if (method === "GET" && route.endsWith("/events")) return "realtime";
  if (method === "GET" && route.endsWith("/projection")) return "projection";
  if (method !== "GET" && (route.startsWith("/api/ai-collaboration/") || route === "/api/knowledge-lecture")) {
    return status === 202 ? "ai-background" : "ai-interactive";
  }
  return method === "GET" || method === "HEAD" ? "read" : "write";
}
