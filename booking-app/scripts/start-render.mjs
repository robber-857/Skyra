import { spawn } from "node:child_process";
import process from "node:process";

const children = [
  spawn("npm", ["run", "start"], { stdio: "inherit" }),
  spawn("npm", ["run", "start:worker"], { stdio: "inherit" }),
];

let shuttingDown = false;
let requestedExitCode = 0;

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(requestedExitCode), 10000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => shutdown(signal));

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    shutdown("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      if (
        children.every(
          (candidate) =>
            candidate.exitCode !== null || candidate.signalCode !== null,
        )
      )
        process.exit(requestedExitCode);
      return;
    }
    console.error(
      `Render child process exited unexpectedly (code=${code}, signal=${signal}).`,
    );
    shutdown("SIGTERM", code ?? 1);
  });
}
