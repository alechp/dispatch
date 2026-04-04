#!/usr/bin/env bun
/**
 * Dispatch Runner — Bun Shell CLI for the Dispatch Tauri App
 * Zero external dependencies. Run with: bun scripts/run.ts
 */

import { $ } from "bun";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { existsSync } from "fs";

// ── ANSI Colors ──────────────────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgCyan: "\x1b[46m",
  bgMagenta: "\x1b[45m",
};

const c = colors;

// ── Types ────────────────────────────────────────────────────────────────────

type Mode = "run" | "dev" | "build" | "test" | "deps" | "install" | "health" | "clean";

// ── Runner ───────────────────────────────────────────────────────────────────

class DispatchRunner {
  private verbose: boolean;
  private projectRoot: string;

  constructor() {
    this.verbose = process.argv.includes("--verbose");
    this.projectRoot = this.resolveProjectRoot();
  }

  private resolveProjectRoot() {
    const scriptDir = dirname(Bun.main);
    const siblingPackageJson = resolve(scriptDir, "package.json");
    if (existsSync(siblingPackageJson)) {
      return scriptDir;
    }

    return resolve(scriptDir, "..");
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  private log(msg: string) {
    console.log(msg);
  }

  private logStep(msg: string) {
    console.log(`\n  ${c.cyan}${c.bold}>>>${c.reset} ${c.white}${msg}${c.reset}`);
  }

  private logSuccess(msg: string) {
    console.log(`  ${c.green}${c.bold} \u2713 ${c.reset} ${c.green}${msg}${c.reset}`);
  }

  private logError(msg: string) {
    console.error(`  ${c.red}${c.bold} \u2717 ${c.reset} ${c.red}${msg}${c.reset}`);
  }

  private logWarning(msg: string) {
    console.log(`  ${c.yellow}${c.bold} ! ${c.reset} ${c.yellow}${msg}${c.reset}`);
  }

  private logVerbose(msg: string) {
    if (this.verbose) {
      console.log(`  ${c.gray}${msg}${c.reset}`);
    }
  }

  // ── Banner ───────────────────────────────────────────────────────────────

  private printBanner() {
    const hr = `${c.dim}${c.cyan}${"─".repeat(56)}${c.reset}`;
    console.log();
    console.log(hr);
    console.log(`${c.bold}${c.cyan}
    ██████╗ ██╗███████╗██████╗  █████╗ ████████╗ ██████╗██╗  ██╗
    ██╔══██╗██║██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔════╝██║  ██║
    ██║  ██║██║███████╗██████╔╝███████║   ██║   ██║     ███████║
    ██║  ██║██║╚════██║██╔═══╝ ██╔══██║   ██║   ██║     ██╔══██║
    ██████╔╝██║███████║██║     ██║  ██║   ██║   ╚██████╗██║  ██║
    ╚═════╝ ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝${c.reset}`);
    console.log();
    console.log(`  ${c.dim}${c.white}Local-first AI orchestration layer${c.reset}`);
    console.log(`  ${c.gray}Tauri 2 \u00b7 React \u00b7 Rust \u00b7 Bun${c.reset}`);
    console.log(hr);
    console.log();
  }

  // ── Prompt ───────────────────────────────────────────────────────────────

  private prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // ── Environment Validation ───────────────────────────────────────────────

  private async validateEnv() {
    this.logStep("Validating environment");

    const checks: Array<{ name: string; cmd: string[] }> = [
      { name: "bun", cmd: ["bun", "--version"] },
      { name: "cargo", cmd: ["cargo", "--version"] },
      { name: "rustc", cmd: ["rustc", "--version"] },
    ];

    for (const { name, cmd } of checks) {
      try {
        const result = await Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }).exited;
        if (result !== 0) throw new Error();
        this.logVerbose(`${name}: found`);
      } catch {
        this.logError(`${name} is not installed or not in PATH`);
        process.exit(1);
      }
    }

    this.logSuccess("Environment OK");
  }

  // ── Shell Helper ─────────────────────────────────────────────────────────

  private async run(label: string, cmd: string) {
    this.logStep(label);
    this.logVerbose(`$ ${cmd}`);
    const result = await $`sh -c ${cmd}`.cwd(this.projectRoot).nothrow();
    if (result.exitCode !== 0) {
      this.logError(`Command failed (exit ${result.exitCode})`);
      return false;
    }
    this.logSuccess(label);
    return true;
  }

  private async pathExists(path: string) {
    return Bun.file(path).exists();
  }

  private async ensureJsDepsInstalled(context: string) {
    const requiredPaths = [
      resolve(this.projectRoot, "node_modules/@tauri-apps/cli/package.json"),
      resolve(this.projectRoot, "node_modules/@socketsecurity/bun-security-scanner/package.json"),
    ];

    for (const path of requiredPaths) {
      if (!(await this.pathExists(path))) {
        this.logVerbose(`Missing dependency for ${context}: ${path}`);
        return this.run("Installing JS dependencies", "bun install");
      }
    }

    this.logVerbose(`JS dependencies OK for ${context}`);
    return true;
  }

  // ── Modes ────────────────────────────────────────────────────────────────

  private async modeRunEverything() {
    await this.validateEnv();

    if (!(await this.run("Installing dependencies", "bun install"))) return;
    if (!(await this.run("Building Rust workspace", "cargo build --manifest-path src-tauri/Cargo.toml -p dispatch"))) return;
    if (!(await this.run("Launching Tauri dev", "bun run tauri dev"))) return;
  }

  private async modeDev() {
    await this.validateEnv();
    if (!(await this.ensureJsDepsInstalled("dev"))) return;
    await this.run("Starting Tauri dev (hot reload)", "bun run tauri dev");
  }

  private async modeBuild() {
    await this.validateEnv();
    if (!(await this.ensureJsDepsInstalled("build"))) return;
    await this.run("Building production release", "bun run tauri build --bundles app");
  }

  private async modeTest() {
    await this.validateEnv();
    if (!(await this.ensureJsDepsInstalled("test"))) return;

    const cargo = await this.run(
      "Running Cargo tests",
      "cargo test --manifest-path src-tauri/Cargo.toml"
    );
    const tsc = await this.run("TypeScript type check", "bun run tsc --noEmit");

    if (cargo && tsc) {
      this.logSuccess("All tests passed");
    } else {
      this.logError("Some checks failed");
      process.exit(1);
    }
  }

  private async modeDeps() {
    await this.run("Installing JS dependencies", "bun install");
    await this.run(
      "Fetching Cargo dependencies",
      "cargo fetch --manifest-path src-tauri/Cargo.toml"
    );
  }

  private async modeInstall() {
    await this.validateEnv();
    if (!(await this.ensureJsDepsInstalled("install"))) return;
    this.logStep("Building and installing Dispatch.app to /Applications");

    // Step 1: Build the release .app bundle (skip DMG to avoid intermittent failures)
    if (!(await this.run("Building release bundle", "bun run tauri build --bundles app"))) {
      this.logError("Build failed — cannot install");
      return;
    }

    // Step 2: Find the .app bundle
    const bundleDir = resolve(this.projectRoot, "src-tauri/target/release/bundle/macos");
    const appName = "Dispatch.app";
    const sourcePath = resolve(bundleDir, appName);
    const destPath = `/Applications/${appName}`;

    try {
      const stat = await Bun.file(resolve(sourcePath, "Contents/Info.plist")).exists();
      if (!stat) {
        this.logError(`App bundle not found at ${sourcePath}`);
        return;
      }
    } catch {
      this.logError(`App bundle not found at ${sourcePath}`);
      return;
    }

    // Step 3: Check if already installed
    const existingApp = await Bun.file(resolve(destPath, "Contents/Info.plist")).exists();
    if (existingApp) {
      this.logWarning(`${destPath} already exists — it will be replaced`);
      // Kill the running app first if any
      await $`pkill -f "Dispatch.app" 2>/dev/null`.cwd(this.projectRoot).nothrow();
      await $`sleep 1`.nothrow();
      if (!(await this.run("Removing old installation", `rm -rf "${destPath}"`))) {
        this.logError("Failed to remove old installation. Try: sudo rm -rf /Applications/Dispatch.app");
        return;
      }
    }

    // Step 4: Copy to /Applications
    if (!(await this.run("Copying to /Applications", `cp -R "${sourcePath}" "${destPath}"`))) {
      this.logError("Copy failed. You may need to run with sudo or copy manually:");
      this.log(`  ${c.dim}cp -R "${sourcePath}" /Applications/${c.reset}`);
      return;
    }

    this.logSuccess(`Installed to ${destPath}`);

    // Step 5: Open the app so macOS registers it for permissions
    this.logStep("Launching Dispatch for first-time permission setup");
    this.log(`  ${c.dim}macOS will prompt for Input Monitoring permission on first use.${c.reset}`);
    this.log(`  ${c.dim}Grant access in: System Settings > Privacy & Security > Input Monitoring${c.reset}`);
    await $`open "${destPath}"`.cwd(this.projectRoot).nothrow();

    this.logSuccess("Installation complete");
  }

  private async modeHealth() {
    this.logStep("Health check");

    // Check HTTP endpoint
    try {
      const resp = await fetch("http://127.0.0.1:9394/health");
      if (resp.ok) {
        const body = await resp.text();
        this.logSuccess(`Health endpoint: ${resp.status} — ${body}`);
      } else {
        this.logWarning(`Health endpoint responded ${resp.status}`);
      }
    } catch {
      this.logWarning("Health endpoint not reachable (is the app running?)");
    }

    // Check processes
    const procs = await $`ps aux`.text();
    const tauriRunning = procs.includes("dispatch") || procs.includes("tauri");
    if (tauriRunning) {
      this.logSuccess("Dispatch process detected");
    } else {
      this.logWarning("No Dispatch process found");
    }
  }

  private async modeClean() {
    const targets = ["src-tauri/target", "dist", "node_modules"];
    this.logWarning(`This will remove: ${targets.join(", ")}`);
    const answer = await this.prompt(`  ${c.yellow}Continue? [y/N] ${c.reset}`);
    if (answer.toLowerCase() !== "y") {
      this.log(`  ${c.dim}Cancelled.${c.reset}`);
      return;
    }

    for (const dir of targets) {
      await this.run(`Removing ${dir}`, `rm -rf ${dir}`);
    }
    this.logSuccess("Clean complete");
  }

  // ── Help ─────────────────────────────────────────────────────────────────

  private printHelp() {
    this.printBanner();
    console.log(`  ${c.bold}${c.white}Usage:${c.reset}  dispatch [options]`);
    console.log();
    console.log(`  ${c.bold}${c.white}Options:${c.reset}`);
    console.log(`    ${c.cyan}--mode=<mode>${c.reset}    Skip menu and run a mode directly`);
    console.log(`    ${c.cyan}--verbose${c.reset}         Show extra output`);
    console.log(`    ${c.cyan}--help${c.reset}            Show this help`);
    console.log();
    console.log(`  ${c.bold}${c.white}Modes:${c.reset}`);
    console.log(`    ${c.green}run${c.reset}       Full setup + launch (install, build, run)`);
    console.log(`    ${c.green}dev${c.reset}       Start tauri dev (hot reload)`);
    console.log(`    ${c.green}build${c.reset}     Compile release binary`);
    console.log(`    ${c.green}test${c.reset}      Cargo test + TypeScript check`);
    console.log(`    ${c.green}deps${c.reset}      bun install + cargo fetch`);
    console.log(`    ${c.green}install${c.reset}   Build + install .app to /Applications`);
    console.log(`    ${c.green}health${c.reset}    Ping :9394/health, check processes`);
    console.log(`    ${c.green}clean${c.reset}     Remove target/, dist/, node_modules/`);
    console.log();
    console.log(`  ${c.bold}${c.white}Examples:${c.reset}`);
    console.log(`    ${c.dim}$ dispatch${c.reset}                   Interactive menu`);
    console.log(`    ${c.dim}$ dispatch --mode=dev${c.reset}        Launch dev mode`);
    console.log(`    ${c.dim}$ dispatch --mode=test${c.reset}       Run all checks`);
    console.log();
  }

  // ── Interactive Menu ─────────────────────────────────────────────────────

  private async showMenu(): Promise<Mode | null> {
    const items = [
      { key: "1", mode: "run" as Mode, label: "Run Everything", desc: "Full setup + launch (install, build, run)" },
      { key: "2", mode: "dev" as Mode, label: "Dev Mode", desc: "Start tauri dev (hot reload)" },
      { key: "3", mode: "build" as Mode, label: "Build Production", desc: "Compile release binary" },
      { key: "4", mode: "test" as Mode, label: "Run Tests", desc: "Cargo test + TypeScript check" },
      { key: "5", mode: "deps" as Mode, label: "Install Dependencies", desc: "bun install + cargo fetch" },
      { key: "6", mode: "install" as Mode, label: "Install to System", desc: "Build + copy to /Applications" },
      { key: "7", mode: "health" as Mode, label: "Health Check", desc: "Ping :9394/health, check processes" },
      { key: "8", mode: "clean" as Mode, label: "Clean", desc: "Remove target/, dist/, node_modules/" },
    ];

    for (const item of items) {
      console.log(
        `  ${c.bold}${c.cyan}${item.key})${c.reset} ${c.white}${item.label.padEnd(24)}${c.reset}${c.dim}${item.desc}${c.reset}`
      );
    }
    console.log(`  ${c.bold}${c.cyan}0)${c.reset} ${c.white}Exit${c.reset}`);
    console.log();

    const answer = await this.prompt(`  ${c.magenta}Select [${c.bold}1${c.reset}${c.magenta}]: ${c.reset}`);
    const choice = answer || "1";

    if (choice === "0") return null;
    const found = items.find((i) => i.key === choice);
    if (!found) {
      this.logError(`Invalid selection: ${choice}`);
      return null;
    }
    return found.mode;
  }

  // ── Dispatch Mode ────────────────────────────────────────────────────────

  private async executeMode(mode: Mode) {
    switch (mode) {
      case "run":
        return this.modeRunEverything();
      case "dev":
        return this.modeDev();
      case "build":
        return this.modeBuild();
      case "test":
        return this.modeTest();
      case "deps":
        return this.modeDeps();
      case "install":
        return this.modeInstall();
      case "health":
        return this.modeHealth();
      case "clean":
        return this.modeClean();
    }
  }

  // ── Entry Point ──────────────────────────────────────────────────────────

  async main() {
    // SIGINT handler
    process.on("SIGINT", () => {
      console.log(`\n  ${c.dim}Interrupted. Goodbye.${c.reset}\n`);
      process.exit(0);
    });

    // Parse args
    const args = process.argv.slice(2);

    if (args.includes("--help")) {
      this.printHelp();
      return;
    }

    const modeArg = args.find((a) => a.startsWith("--mode="));
    const validModes: Mode[] = ["run", "dev", "build", "test", "deps", "install", "health", "clean"];

    if (modeArg) {
      const mode = modeArg.split("=")[1] as Mode;
      if (!validModes.includes(mode)) {
        this.logError(`Unknown mode: ${mode}`);
        this.logWarning(`Valid modes: ${validModes.join(", ")}`);
        process.exit(1);
      }
      this.printBanner();
      await this.executeMode(mode);
      return;
    }

    // Interactive menu
    this.printBanner();
    const mode = await this.showMenu();
    if (!mode) {
      this.log(`\n  ${c.dim}Goodbye.${c.reset}\n`);
      return;
    }

    await this.executeMode(mode);
    console.log();
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const runner = new DispatchRunner();
runner.main().catch((err) => {
  console.error(`\n  \x1b[31m\x1b[1mFatal:\x1b[0m ${err.message}\n`);
  process.exit(1);
});
