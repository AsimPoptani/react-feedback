#!/usr/bin/env bun
// react-feedback serve         start the feedback server (FEEDBACK_DIR, FEEDBACK_HOST, PORT)
// react-feedback mcp           an MCP server on stdio (FEEDBACK_AGENT_NAME names the agent)
// react-feedback --version     print the version
// react-feedback <command> ... the agent CLI (list, reply, new, status, ask, todo, metrics ...)
import { run } from "../server/cli";
import { serverOptions } from "../server/server";
import { Invalid } from "../server/store";
import { startScheduler } from "../server/reminders";
import { loadProjects } from "../server/projects";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "serve") {
  let options: ReturnType<typeof serverOptions>;
  try { options = serverOptions(); } catch (error) {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  }
  const server = Bun.serve(options);
  if (!/^(0|off|false|no)$/i.test(process.env.FEEDBACK_REMINDERS?.trim() ?? "")) {
    const dirs = process.env.FEEDBACK_PROJECTS?.trim() ? loadProjects(process.env).map((project) => project.dir) : [process.env.FEEDBACK_DIR ?? resolve(process.cwd(), "feedback-data")];
    for (const folder of dirs) startScheduler(folder);
  }
  console.log(`react-feedback listening on http://${server.hostname}:${server.port} (inbox at /__feedback/inbox/)`);
} else if (args[0] === "mcp") {
  const { runMcp } = await import("../server/mcp");
  const { defaultDir } = await import("../server/cli");
  await runMcp(defaultDir(), process.env, args).catch((error) => {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  });
} else {
  run(args)
    .then((out) => console.log(out))
    .catch((error) => {
      console.error(error instanceof Invalid ? error.message : error);
      process.exit(error instanceof Invalid ? 2 : 1);
    });
}
