# ACP v1 Wire Reference

Sources fetched: `schema.md`, `overview.md`, `transports.md`, `initialization.md`,
`session-setup.md`, `session-modes.md`, `session-config-options.md`, `prompt-turn.md`,
`content.md`, `tool-calls.md`, `agent-plan.md`, `file-system.md`, `authentication.md`,
`terminals.md` — all from `https://agentclientprotocol.com/protocol/v1/`.

Field names, enum values, and discriminators are quoted verbatim from the docs.
Where a detail was not pinned down, the section says **"not specified — check schema"**.

---

## 1. Transport & Framing

**Who launches whom:** The **client launches the agent as a subprocess.**

**Framing:** Newline-delimited JSON-RPC 2.0. There are **no Content-Length headers.**

> "Messages are delimited by newlines (`\n`), and **MUST NOT** contain embedded newlines."

**stdin/stdout rules:**
- Agent reads JSON-RPC messages from `stdin`.
- Agent writes JSON-RPC messages to `stdout`.
- > "The agent **MUST NOT** write anything to its `stdout` that is not a valid ACP message."

**Logging:**
- > "The agent **MAY** write UTF-8 strings to its standard error (`stderr`) for logging purposes."

**Protocol version field:** `"jsonrpc": "2.0"` on every message.

**Conventions:**
- All file paths MUST be absolute.
- Line numbers are 1-based.
- Object property keys use `camelCase`.
- Discriminator field values use `snake_case`.
- Custom extensions use underscore prefixes (`_methodName`, `_meta`).

---

## 2. Direction of Every Method

### Client → Agent (requests the client sends)

| Method | Notes |
|---|---|
| `initialize` | Baseline; required first call |
| `authenticate` | Only if agent advertises auth methods |
| `logout` | Requires `agentCapabilities.auth.logout` |
| `session/new` | Create a session |
| `session/load` | Requires `agentCapabilities.loadSession` |
| `session/resume` | Requires `agentCapabilities.sessionCapabilities.resume` |
| `session/close` | Requires `agentCapabilities.sessionCapabilities.close` |
| `session/delete` | Not specified — check schema |
| `session/list` | Not specified — check schema |
| `session/prompt` | Baseline; the main turn method |
| `session/cancel` | Abort an ongoing turn |
| `session/set_mode` | Client-initiated mode switch |
| `session/set_config_option` | Client-initiated config change |

### Agent → Client (callbacks the agent makes)

| Method | Type | Notes |
|---|---|---|
| `session/update` | Notification (no response) | Real-time progress stream |
| `session/request_permission` | Request (expects response) | Permission gate before tool execution |
| `fs/read_text_file` | Request | Requires `clientCapabilities.fs.readTextFile` |
| `fs/write_text_file` | Request | Requires `clientCapabilities.fs.writeTextFile` |
| `terminal/create` | Request | Requires `clientCapabilities.terminal` |
| `terminal/output` | Request | Requires `clientCapabilities.terminal` |
| `terminal/wait_for_exit` | Request | Requires `clientCapabilities.terminal` |
| `terminal/kill` | Request | Requires `clientCapabilities.terminal` |
| `terminal/release` | Request | Requires `clientCapabilities.terminal` |

---

## 3. `initialize` / `authenticate`

### `initialize` Request (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "string",
      "title": "string",
      "version": "string"
    },
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      },
      "terminal": true,
      "_meta": null
    }
  }
}
```

- `protocolVersion`: single integer (MAJOR only).
- `clientInfo`: optional.
- `clientCapabilities` defaults: `fs.readTextFile: false`, `fs.writeTextFile: false`, `terminal: false`.

### `initialize` Response (Agent → Client)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentInfo": { "name": "string", "title": "string", "version": "string" },
    "agentCapabilities": {
      "auth": {
        "logout": true
      },
      "loadSession": true,
      "mcpCapabilities": {
        "http": true,
        "sse": true
      },
      "promptCapabilities": {
        "image": true,
        "audio": true,
        "embeddedContext": true
      },
      "sessionCapabilities": {
        "resume": true,
        "close": true,
        "additionalDirectories": true,
        "delete": true
      },
      "_meta": null
    },
    "authMethods": []
  }
}
```

**Version negotiation:** If the agent cannot support the requested version it responds with its
latest supported version. If the client cannot support the agent's version, the client MUST close
the connection.

**Capability defaults:** All omitted capabilities are treated as unsupported (`false` / absent).

### `authenticate` Request (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {
    "methodId": "string"
  }
}
```

Response: empty result object `{}`.

**Auth method structure** (inside `agentCapabilities.authMethods[]`):
```json
{
  "id": "string",
  "name": "string",
  "description": "string",
  "type": "agent"
}
```
- `type` defaults to `"agent"` when omitted.

### `logout` Request (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "logout",
  "params": {}
}
```

Response: empty result object `{}`. Requires `agentCapabilities.auth.logout === true`.

---

## 4. `session/new` and `session/load`

### `session/new` (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/new",
  "params": {
    "cwd": "/absolute/path",
    "mcpServers": [
      {
        "name": "string",
        "command": "string",
        "args": ["string"],
        "env": [{ "name": "string", "value": "string" }]
      }
    ],
    "additionalDirectories": ["/path/b"],
    "_meta": null
  }
}
```

**`mcpServers` item variants:**

| Transport | Discriminator | Required fields | Capability gate |
|---|---|---|---|
| stdio | *(no `type` field — default)* | `name`, `command`, `args`, `env` | Always supported |
| http | `"type": "http"` | `name`, `url`, `headers` | `mcpCapabilities.http === true` |
| SSE | `"type": "sse"` | `name`, `url`, `headers` | `mcpCapabilities.sse === true` |

- `additionalDirectories`: only when `agentCapabilities.sessionCapabilities.additionalDirectories === true`.

**Response:**
```json
{ "result": { "sessionId": "string" } }
```

### `session/load` (Client → Agent)

Requires `agentCapabilities.loadSession === true`.

```json
{
  "method": "session/load",
  "params": {
    "sessionId": "string",
    "cwd": "/absolute/path",
    "mcpServers": [ ]
  }
}
```

Agent replays conversation history via `session/update` notifications before responding.
Response shape: not specified — check schema (likely `{}` or same as `session/new`).

### `session/resume` (Client → Agent)

Same params as `session/load`. Agent reconnects immediately **without** history replay.
Requires `agentCapabilities.sessionCapabilities.resume === true`.

---

## 5. `session/prompt`

### Request (Client → Agent)

```json
{
  "jsonrpc": "2.0",
  "id": 20,
  "method": "session/prompt",
  "params": {
    "sessionId": "string",
    "prompt": [
      { "type": "text", "text": "Hello" }
    ],
    "_meta": null
  }
}
```

`prompt` is an array of **ContentBlock** objects (see §6).

### Response (Agent → Client)

```json
{
  "result": {
    "stopReason": "end_turn"
  }
}
```

### All `stopReason` values

| Value | Meaning |
|---|---|
| `"end_turn"` | Model finished without requesting additional tools |
| `"max_tokens"` | Token limit reached |
| `"max_turn_requests"` | Model request limit exceeded |
| `"refusal"` | Agent declined to continue |
| `"cancelled"` | Client cancelled the turn via `session/cancel` |

---

## 6. Content Block Types

Discriminator field: **`"type"`**. Baseline client support requires `text` and `resource_link`.

### `text`
```json
{ "type": "text", "text": "string", "annotations": null }
```

### `image`
```json
{ "type": "image", "data": "<base64>", "mimeType": "image/png", "uri": "string", "annotations": null }
```
Requires `agentCapabilities.promptCapabilities.image === true`.

### `audio`
```json
{ "type": "audio", "data": "<base64>", "mimeType": "audio/mp3", "annotations": null }
```
Requires `agentCapabilities.promptCapabilities.audio === true`.

### `resource` (embedded resource)
```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///path/to/file",
    "text": "string content",
    "mimeType": "text/plain"
  },
  "annotations": null
}
```
Blob variant uses `"blob"` (base64) instead of `"text"`.
Requires `agentCapabilities.promptCapabilities.embeddedContext === true`.

### `resource_link`
```json
{
  "type": "resource_link",
  "uri": "file:///path/to/file",
  "name": "string",
  "mimeType": "text/plain",
  "title": "string",
  "description": "string",
  "size": 1024,
  "annotations": null
}
```
Required fields: `uri`, `name`. All others optional.

> "Content blocks appear in user prompts, language model output, and tool call results."

---

## 7. `session/update` Notification

Direction: Agent → Client (no response expected).

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "string",
    "update": {
      "type": "<discriminator>",
      ...
    },
    "_meta": null
  }
}
```

The `params.update` object has a **`"type"`** discriminator field.

### All `update.type` variants

#### `agent_message_chunk`
```json
{
  "type": "agent_message_chunk",
  "messageId": "string",
  "content": { }
}
```
`content` is a `ContentChunk` — not specified further, check schema.

#### `agent_thought_chunk`
```json
{
  "type": "agent_thought_chunk",
  "content": { }
}
```

#### `user_message_chunk`
```json
{
  "type": "user_message_chunk",
  "messageId": "string",
  "content": { }
}
```

#### `tool_call`
```json
{
  "type": "tool_call",
  "toolCall": { }
}
```
`toolCall` is a `ToolCallUpdate` object (see §8).

#### `tool_call_update`
```json
{
  "type": "tool_call_update",
  "toolCall": { }
}
```

#### `plan`
```json
{
  "type": "plan",
  "plan": [
    {
      "content": "Human-readable description of the task",
      "priority": "high",
      "status": "pending"
    }
  ]
}
```
Client MUST replace the current plan completely on each `plan` update.
- `priority` values: `"high"`, `"medium"`, `"low"`
- `status` values: `"pending"`, `"in_progress"`, `"completed"`

#### `current_mode_update`
```json
{
  "type": "current_mode_update",
  "currentModeId": "string"
}
```

#### `config_option_update`
```json
{
  "type": "config_option_update",
  "configOptions": [
    {
      "id": "string",
      "name": "string",
      "type": "select",
      "currentValue": "string",
      "options": [
        { "value": "string", "name": "string", "description": "string" }
      ]
    }
  ]
}
```

#### `available_commands_update`
```json
{
  "type": "available_commands_update",
  "availableCommands": [ ]
}
```
`AvailableCommand` shape: not specified — check schema.

**Note:** A `usage_update` variant was not documented in any fetched page.

All `update` objects include `"_meta": object | null` for extensibility.

---

## 8. `tool_call` Lifecycle

### `ToolCallUpdate` object fields

| Field | Required | Type | Notes |
|---|---|---|---|
| `toolCallId` | Yes | string | Unique within the session |
| `title` | Yes (initial) | string | Human-readable description |
| `kind` | Yes (initial) | string enum | Category (see below) |
| `status` | Yes (initial) | string enum | Execution state (see below) |
| `content` | No | ContentBlock[] or Diff or TerminalOutput | Output produced |
| `locations` | No | string[] | Affected absolute file paths |
| `rawInput` | No | any | Raw parameters passed to the tool |
| `rawOutput` | No | any | Raw result from the tool |

> "All fields except `toolCallId` are optional in updates."

### `kind` values

`"read"` | `"edit"` | `"delete"` | `"move"` | `"search"` | `"execute"` | `"think"` | `"fetch"` | `"other"`

### `status` values

| Value | Meaning |
|---|---|
| `"pending"` | Awaiting input or approval |
| `"in_progress"` | Currently executing |
| `"completed"` | Success |
| `"failed"` | Error occurred |

### Content variants in `tool_call`

- Standard **ContentBlock** array (text, image, resource, etc.)
- **Diff**: shows file modifications with old/new text — not specified further, check schema.
- **Terminal output**: from live command execution — not specified further, check schema.

---

## 9. Client-Side Methods (Agent → Client)

### `session/request_permission`

Agent calls this before sensitive operations.

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 30,
  "method": "session/request_permission",
  "params": {
    "sessionId": "string",
    "toolCall": { },
    "options": ["allow_once", "allow_always", "reject_once", "reject_always"],
    "_meta": null
  }
}
```

`toolCall` is a `ToolCallUpdate` object (populated before permission).
`options` is a `PermissionOption[]` — the agent selects which options to offer.

**Response shape (Client → Agent):** not specified — check schema. Presumably the chosen option string or `"cancelled"` when the prompt turn is interrupted.

**`PermissionOption` enum values:** `"allow_once"`, `"allow_always"`, `"reject_once"`, `"reject_always"`
**Outcome `"cancelled"`** is returned when the prompt turn is interrupted before the user responds.

---

### `fs/read_text_file`

Requires `clientCapabilities.fs.readTextFile === true`.

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 31,
  "method": "fs/read_text_file",
  "params": {
    "sessionId": "string",
    "path": "/absolute/path/to/file",
    "line": 1,
    "limit": 100
  }
}
```

- `path`: required, absolute.
- `line`: optional, 1-based starting line.
- `limit`: optional, maximum lines to read.

**Response:**
```json
{ "result": { "content": "string" } }
```

---

### `fs/write_text_file`

Requires `clientCapabilities.fs.writeTextFile === true`.

**Request (Agent → Client):**
```json
{
  "jsonrpc": "2.0",
  "id": 32,
  "method": "fs/write_text_file",
  "params": {
    "sessionId": "string",
    "path": "/absolute/path/to/file",
    "content": "string"
  }
}
```

- Client creates the file if it does not exist.

**Response:** `{ "result": null }`

---

### Terminal Methods

All require `clientCapabilities.terminal === true`.
Agent MUST release the terminal with `terminal/release` when no longer needed.

#### `terminal/create`

```json
{
  "method": "terminal/create",
  "params": {
    "sessionId": "string",
    "command": "string",
    "args": ["string"],
    "env": [{ "name": "string", "value": "string" }],
    "cwd": "/absolute/path",
    "outputByteLimit": 1048576
  }
}
```

Required: `sessionId`, `command`. All others optional.

**Response:** `{ "result": { "terminalId": "string" } }`

---

#### `terminal/output`

```json
{
  "method": "terminal/output",
  "params": {
    "sessionId": "string",
    "terminalId": "string"
  }
}
```

Retrieves current output **without** waiting for completion.

**Response:**
```json
{
  "result": {
    "output": "string",
    "truncated": false,
    "exitStatus": {
      "exitCode": 0,
      "signal": null
    }
  }
}
```

`exitStatus` is optional (absent if still running).

---

#### `terminal/wait_for_exit`

```json
{
  "method": "terminal/wait_for_exit",
  "params": {
    "sessionId": "string",
    "terminalId": "string"
  }
}
```

Blocks until command finishes.

**Response:**
```json
{ "result": { "exitCode": 0, "signal": null } }
```

---

#### `terminal/kill`

```json
{
  "method": "terminal/kill",
  "params": {
    "sessionId": "string",
    "terminalId": "string"
  }
}
```

Terminates command but keeps terminal valid. Response: not specified — check schema.

---

#### `terminal/release`

```json
{
  "method": "terminal/release",
  "params": {
    "sessionId": "string",
    "terminalId": "string"
  }
}
```

Kills any running command and frees all terminal resources. Response: not specified — check schema.

---

## 10. `session/cancel`

Direction: Client → Agent.

```json
{
  "jsonrpc": "2.0",
  "id": 99,
  "method": "session/cancel",
  "params": {
    "sessionId": "string",
    "_meta": null
  }
}
```

Agent must return `stopReason: "cancelled"` on the in-flight `session/prompt` response.
Agent must catch exceptions (including library API exceptions) and return `"cancelled"` rather than an error response.

---

## 11. Session Modes & Config Options

### `session/set_mode` (Client → Agent)

```json
{
  "method": "session/set_mode",
  "params": {
    "sessionId": "string",
    "modeId": "string"
  }
}
```

Response: not specified — check schema.

**`SessionMode` object:**
```json
{ "id": "string", "name": "string", "description": "string" }
```

Example mode IDs (from docs, not exhaustive): `"ask"`, `"architect"`, `"code"`.

**`SessionModeState`:**
```json
{
  "currentModeId": "string",
  "availableModes": [ ]
}
```

### `session/set_config_option` (Client → Agent)

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "string",
    "configId": "string",
    "value": "string"
  }
}
```

Agent responds with the **complete** `configOptions` array (so dependent updates cascade).

**`ConfigOption` structure:**
```json
{
  "id": "string",
  "name": "string",
  "type": "select",
  "currentValue": "string",
  "options": [
    { "value": "string", "name": "string", "description": "string" }
  ]
}
```

`type` currently only supports `"select"`.

**`category` semantic hints:** `"mode"`, `"model"`, `"thought_level"`. Custom categories use `_` prefix.

**Transition note:** Config Options supersede the older Session Modes API. Agents should provide both for backward compatibility.

---

## 12. Gaps / Unverified

The following details were either absent from the fetched pages or left ambiguous. Verify against the live JSON schema at `https://agentclientprotocol.com/protocol/v1/schema.md`.

| Topic | Gap |
|---|---|
| `session/request_permission` response shape | Docs describe the options but not the exact response JSON. Likely `{ "result": { "outcome": "allow_once" } }` — unverified. |
| `ContentChunk` type | Referenced in `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` but shape not documented in fetched pages. May be a subset of ContentBlock. |
| `AvailableCommand` shape | `available_commands_update` references this type but its fields are not documented in fetched pages. |
| `session/load` response | Docs say agent replays history via `session/update`; the final response shape is not specified. |
| `session/resume` response | Same gap as `session/load`. |
| `session/close` params and response | Docs confirm the method exists; exact params/response not shown. |
| `session/delete` params and response | Method listed in schema summary; no detail page fetched. |
| `session/list` params and response | Method listed in schema summary; no detail page fetched. |
| `terminal/kill` response | Not specified. |
| `terminal/release` response | Not specified. |
| `Diff` content type | Referenced as a `tool_call` content variant; fields (old text, new text, path) not formally documented. |
| `TerminalOutput` content type | Referenced as a `tool_call` content variant; fields not formally documented. |
| `usage_update` | Not documented on any fetched page; may exist — check schema. |
| `mcpServers` stdio `env` item shape | Inferred as `{ name, value }` from terminal env pattern; not explicitly confirmed. |
| `EnvVariable` shape | Used in both `mcpServers` and `terminal/create`; assumed `{ name: string, value: string }` — unverified. |
| `HttpHeader` shape | Used in http/SSE MCP server configs; shape not specified. |
| `SessionCapabilities.delete` | Listed in agentCapabilities summary but no separate doc page. |
| `session/set_mode` response | Not specified. |
| `_meta` field schema | Reserved for custom extensions; exact rules not documented. |
| `protocolVersion` as integer | Docs say "single integer representing the MAJOR version" — confirm current value is `1`. |
