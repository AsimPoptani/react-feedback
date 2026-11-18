#!/usr/bin/env bun
// react-feedback serve         start the feedback server (FEEDBACK_DIR, FEEDBACK_HOST, PORT)
// react-feedback <command> ... the agent CLI (list, reply, new, status, ask, todo, metrics ...)
import { run } from "../server/cli";
import { serverOptions } from "../server/server";
import { Invalid } from "../server/store";

const args = process.argv.slice(2);
if (args[0] === "serve") {
  let options: ReturnType<typeof serverOptions>;
  try { options = serverOptions(); } catch (error) {
    console.error(error instanceof Invalid ? error.message : error);
    process.exit(1);
  }
  const server = Bun.serve(options);
  console.log(`react-feedback listening on http://${server.hostname}:${server.port} (inbox at /__feedback/inbox/)`);
} else {
  run(args)
    .then((out) => console.log(out))
    .catch((error) => {
      console.error(error instanceof Invalid ? error.message : error);
      process.exit(error instanceof Invalid ? 2 : 1);
    });
}
