/**
 * Fake ACP agent (Node) — spawned by the AcpAdapter smoke test. No Python, no
 * API key. Implements the agent side of ACP via the SDK: initialize, newSession,
 * prompt (streams one agent_message_chunk, returns end_turn + usage in _meta).
 *
 * MUST write only ACP frames to stdout (logs would corrupt the stream).
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

new acp.AgentSideConnection(
  (conn) => ({
    async initialize(): Promise<acp.InitializeResponse> {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} };
    },
    async newSession(): Promise<acp.NewSessionResponse> {
      return { sessionId: "sess_fake_1" };
    },
    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from ACP" } },
      });
      return {
        stopReason: "end_turn",
        _meta: {
          inteliside_usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, model: "anthropic/claude-sonnet-4-6" },
        },
      };
    },
    async cancel(): Promise<void> {
      // no-op
    },
  }),
  stream,
);
