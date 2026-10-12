import "./env.js";
import net from "node:net";
import { spawn } from "node:child_process";
import { loadSecrets, makeCipher, resolveDataDir } from "./crypto.js";
import { DEFAULT_USER, Store } from "./db.js";
import { isPackaged } from "./env.js";
import { Hub } from "./events.js";
import { buildApp } from "./http.js";
import { getSettings, isConfigured } from "./settings.js";
import { registerTwilio } from "./twilio/index.js";

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
  } catch {
    // no browser available; the banner shows the URL
  }
}

async function main() {
  const dataDir = resolveDataDir();
  const secrets = loadSecrets(dataDir);
  const store = new Store(dataDir, makeCipher(secrets.encryptionKey));
  const stale = store.failStaleLiveCalls();
  const hub = new Hub();
  const host = process.env.HOST || "127.0.0.1";
  const ctx = { store, hub };
  const app = await buildApp({ ...ctx, secrets, host, extraChannel: (a) => registerTwilio(a, ctx) });

  const first = Number(process.env.PORT) || 4317;
  let port = 0;
  for (let p = first; p < first + 10 && !port; p++) if (await portFree(host, p)) port = p;
  if (!port) throw new Error(`Ports ${first}-${first + 9} are all in use. Set PORT to a free port.`);
  await app.listen({ host, port });

  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${browserHost}:${port}/`;
  const s = getSettings(store, DEFAULT_USER);
  console.log(
    [
      "",
      "  AI Caller is running",
      `  Dashboard:   ${url}`,
      `  Data folder: ${dataDir}`,
      `  Model:       ${isConfigured(s) ? `${s.callModel} (${s.provider})` : "not set up yet, open Settings in the dashboard"}`,
      stale ? `  Marked ${stale} unfinished call(s) from the last run as failed.` : "",
      "  Keep this window open while you use AI Caller. Close it to stop.",
      "",
    ]
      .filter((l, i, all) => l || i === 0 || i === all.length - 1)
      .join("\n"),
  );
  if (process.env.OPEN_BROWSER !== "0") openBrowser(`${url}#token=${secrets.dashboardToken}`);

  const stop = async () => {
    await app.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`\nAI Caller could not start: ${(err as Error).stack ?? err}`);
  if (isPackaged()) {
    console.error("\nThis window closes in 60 seconds.");
    setTimeout(() => process.exit(1), 60_000);
  } else process.exit(1);
});
