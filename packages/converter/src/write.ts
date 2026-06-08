/** Write an emitted Flue project to disk. Creates parent directories as needed. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlueProject } from "./types.js";

export function writeFlueProject(project: FlueProject, outDir: string): void {
  for (const file of project.files) {
    const abs = join(outDir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content);
  }
}
