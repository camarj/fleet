/**
 * Low-level process primitives shared across deploy targets and the
 * DockerProvisioner. Kept transport-agnostic and dependency-free so neither the
 * deployer nor the provisioner imports the other (no cycles).
 */

import { spawn } from "node:child_process";

/** Receives batches of output lines as a long-running command streams them. */
export type LogSink = (lines: string[]) => void;

/** Error surfaced to the user when a deploy/provision step fails. */
export class DeployError extends Error {}

/**
 * Run a command, streaming its combined stdout/stderr to `onLog` line-by-line as
 * it arrives (so the UI shows live progress), and resolving with the exit status
 * + full captured output. Never rejects.
 */
export function spawnStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  onLog: LogSink,
): Promise<{ status: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let buf = "";
    const onChunk = (data: Buffer): void => {
      const text = data.toString();
      output += text;
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      if (lines.length) onLog(lines);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      onLog([err.message]);
      resolve({ status: 1, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      if (buf) onLog([buf]);
      resolve({ status: code ?? 0, output });
    });
  });
}
