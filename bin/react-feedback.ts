#!/usr/bin/env bun
// react-feedback serve [--remote]  start the feedback server (FEEDBACK_DIR, FEEDBACK_HOST, PORT); --remote adds the paired-device listener (FEEDBACK_REMOTE_PORT, FEEDBACK_PUBLIC_URL)
// react-feedback mcp           an MCP server on stdio (FEEDBACK_AGENT_NAME names the agent; --channel also makes it a Claude Code channel)
// react-feedback claude-code   the Claude Code bridge: hooks that give each session a thread, and wake it when you write there
// react-feedback --version     print the version
// react-feedback <command> ... the agent CLI (list, reply, new, status, ask, todo, metrics ...)
import { run } from "../server/cli";
import { dataDirs, serverOptions, startUploadSweep } from "../server/server";
import { Invalid } from "../server/store";
import { startScheduler } from "../server/reminders";
import { loadReplayDays } from "../server/config";
import { startReplayCleanup } from "../server/replay";
import { remoteWanted, startRemote } from "../server/remote";

const args = process.argv.slice(2);
if (args[0] === "serve") {
  let options: ReturnType<typeof serverOptions>;
  try { options = serverOptions(); } catch (error) {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  }
  const server = Bun.serve(options);
  const dirs = dataDirs();
  startUploadSweep(dirs);
  if (!/^(0|off|false|no)$/i.test(process.env.FEEDBACK_REMINDERS?.trim() ?? "")) {
    for (const folder of dirs) startScheduler(folder);
  }
  // Session replays are kept FEEDBACK_REPLAY_DAYS days (default 30); a pass runs at start and then daily.
  for (const folder of dirs) startReplayCleanup(folder, loadReplayDays(process.env));
  if (remoteWanted(args)) {
    try { await startRemote({ ...options, fetch: options.fetch }, dirs[0]!, process.env); } catch (error) {
      console.error(error instanceof Invalid ? error.message : error);
      process.exit(1);
    }
  }
  console.log(`react-feedback listening on http://${server.hostname}:${server.port} (inbox at /__feedback/inbox/)`);
} else if (args[0] === "mcp") {
  const { runMcp } = await import("../server/mcp");
  const { defaultDir } = await import("../server/cli");
  await runMcp(defaultDir(), process.env, args).catch((error) => {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  });
} else if (args[0] === "proxy") {
  // react-feedback proxy <app-url> --port <n> [--position bottom-right] [--host h --unsafe-public]: the app on :n with the widget in it, no change to the app
  const { proxyOptions, bindHost } = await import("../server/proxy");
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
  const target = args[1], port = Number(flag("port"));
  if (!target || !Number.isInteger(port) || port < 1) { console.error("Usage: react-feedback proxy <app-url> --port <n> [--position bottom-right] [--host <address> --unsafe-public]"); process.exit(1); }
  const inbox = process.env.FEEDBACK_URL ?? `http://${process.env.FEEDBACK_HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8099}`;
  let host: string;
  try { host = bindHost(flag("host"), args.includes("--unsafe-public")); } catch (error) { console.error((error as Error).message); process.exit(1); }
  const server = Bun.serve(proxyOptions(target, port, inbox, flag("position"), host));
  console.log(`react-feedback proxy: http://${server.hostname}:${server.port} → ${target} (widget → ${inbox})`);
} else if (args[0] === "claude-code") {
  const { runClaudeCode } = await import("../server/claude-code");
  const { defaultDir } = await import("../server/cli");
  try { process.exit(await runClaudeCode(args.slice(1), defaultDir())); } catch (error) {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  }
} else {
  run(args)
    .then((out) => console.log(out))
    .catch((error) => {
      console.error(error instanceof Invalid ? error.message : error);
      process.exit(error instanceof Invalid ? 2 : 1);
    });
}
