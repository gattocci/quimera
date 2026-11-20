import { copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const checkout = resolve(root, "chimera");
const manifest = resolve(checkout, "Cargo.toml");
if (!existsSync(manifest)) {
  throw new Error("CHIMERA submodule is missing. Run: git submodule update --init --recursive");
}

execFileSync("cargo", [
  "build", "--manifest-path", manifest, "-p", "chimera-wasm", "--release", "--target", "wasm32-unknown-unknown",
], { cwd: checkout, stdio: "inherit" });

const built = resolve(checkout, "target/wasm32-unknown-unknown/release/chimera_wasm.wasm");
const output = resolve(checkout, "src/wasm/chimera.wasm");
copyFileSync(built, output);
console.log(`Built CHIMERA WASM at ${output}`);
