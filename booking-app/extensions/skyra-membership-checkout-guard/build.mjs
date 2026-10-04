import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const available = spawnSync("cargo", ["--version"], { stdio: "ignore" });
const result =
  available.status === 0
    ? spawnSync(
        "cargo",
        ["build", "--locked", "--target=wasm32-unknown-unknown", "--release"],
        { cwd: directory, stdio: "inherit" },
      )
    : spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--mount",
          `type=bind,source=${directory},target=/work`,
          "--workdir",
          "/work",
          "--env",
          "CARGO_HOME=/work/.cargo-cache",
          "rust@sha256:59037199c44290f2befcdd58dcc540164763fc296950255aaefeef096a1866b0",
          "sh",
          "-c",
          "rustup target add wasm32-unknown-unknown && cargo build --locked --target=wasm32-unknown-unknown --release",
        ],
        { cwd: directory, stdio: "inherit" },
      );
if (result.error)
  process.stderr.write(
    "A Rust toolchain or Docker Desktop is required to build the checkout guard.\n",
  );
process.exit(result.status ?? 1);
