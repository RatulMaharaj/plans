/**
 * Run a command with LLVM's linker, for release builds only.
 *
 * The Command Line Tools linker on this machine (ld-27037) writes proc-macro
 * dylibs with a mis-aligned LINKEDIT string pool. dyld refuses to load them, so
 * rustc reports "can't find crate for serde_derive" and the build dies. Debug
 * builds escape it because those crates are not optimised.
 *
 * rustup ships lld, which does not have the bug. This finds it in whichever
 * toolchain is active rather than hard-coding a path, and gets out of the way
 * on any platform that isn't macOS.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const [, , ...command] = process.argv;
const env = { ...process.env };

if (process.platform === "darwin") {
  try {
    const sysroot = execFileSync("rustc", ["--print", "sysroot"], {
      encoding: "utf8",
    }).trim();
    const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.startsWith("host:"))
      ?.slice(5)
      .trim();
    const gccLd = join(sysroot, "lib", "rustlib", host ?? "", "bin", "gcc-ld");
    if (existsSync(join(gccLd, "ld64.lld"))) {
      const flags = `-C link-arg=-B${gccLd} -C link-arg=-fuse-ld=lld`;
      env.RUSTFLAGS = env.RUSTFLAGS ? `${env.RUSTFLAGS} ${flags}` : flags;
    } else {
      console.warn("release-linker: no bundled lld found, using the system linker");
    }
  } catch (e) {
    console.warn(`release-linker: ${e instanceof Error ? e.message : e}`);
  }
}

spawn(command[0], command.slice(1), { stdio: "inherit", env, shell: false })
  .on("exit", (code) => process.exit(code ?? 1));
