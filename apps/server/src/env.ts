// Import this module first: it hides only node:sqlite's ExperimentalWarning and loads ./.env.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : (opt as { type?: string } | undefined)?.type ?? (warning as Error).name;
  if (type === "ExperimentalWarning" && /sqlite/i.test(message)) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

if (fs.existsSync(path.resolve(".env"))) dotenv.config({ path: path.resolve(".env"), quiet: true });
