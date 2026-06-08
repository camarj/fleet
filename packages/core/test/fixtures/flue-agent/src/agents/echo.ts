/**
 * WS0 fixture — a trivial Flue agent for the wire probe. It runs against a LOCAL
 * mock provider that speaks the OpenAI Chat Completions streaming API (no API
 * key, no real tokens), so the probe exercises Flue's HTTP+WebSocket transport
 * and the FlueAdapter mapping without hitting a real model.
 *
 * IMPORTANT (WS0 finding): a Flue agent is only reachable over HTTP/WebSocket if
 * its module EXPORTS `route` / `websocket` middleware. Without them it builds and
 * loads ("Agents: echo") but is NOT routable ("agent not registered"). FlueAdapter
 * uses the WebSocket route, so `websocket` is required; `route` enables the HTTP
 * POST path too. The converter (WS2) must emit both for every agent.
 */

import { createAgent, registerProvider, type AgentRouteHandler, type AgentWebSocketHandler } from "@flue/runtime";

registerProvider("mock", {
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:5599/v1",
  apiKey: "sk-mock-no-key-needed",
});

export default createAgent(() => ({
  model: "mock/echo-model",
  instructions: "You are an echo agent used for transport testing.",
}));

// Pass-through middleware that simply ENABLE the transports.
export const route: AgentRouteHandler = async (_c, next) => {
  await next();
};
export const websocket: AgentWebSocketHandler = async (_c, next) => {
  await next();
};
