import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { inflateSync } from "node:zlib";

const prefix = "codex-factorio-";
const luaTemplate = fileURLToPath(new URL("native-factorio-control.lua", import.meta.url));
const windows = process.platform === "win32";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngEnding = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

const help = [
  "Usage: node native-factorio.mjs <validate|render> <blueprint.txt> [options]",
  "",
  "validate    Import and materialize one blueprint on an isolated lab surface.",
  "render      Render the materialized blueprint with the native Windows graphics client.",
  "",
  "  --factorio PATH         Factorio executable (overrides FACTORIO_EXE and autodetection)",
  "  --data-dir PATH         Override the installation data directory",
  "  --game base|space-age   Official prototype profile (default: base)",
  "  --output-dir PATH       Write named result files; required for render",
  "  --timeout SECONDS       Native runtime limit (validate: 30; render: 60)",
  "  --pixels-per-tile N     Requested render scale subject to the 4096 px limit (default: 24)",
  "  --padding N             Render padding outside entity and tile bounds (default: 4)",
  "  --no-alt                Hide recipe and entity overlay icons in the screenshot",
  "  --overwrite             Replace this command's existing named output files",
  "  --help                  Print this help",
  "",
  "Single blueprint exchange string or uncompressed JSON. Factorio 2.1.24+.",
  "Validation writes native-validation.json when an output directory is given.",
  "Rendering writes native-blueprint.png and native-blueprint.json.",
  "Neither command loads your saves or custom mods.",
].join("\n");

function numberOption(value, fallback, label, minimum, maximum = Infinity) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < minimum || n > maximum) {
    throw new Error("Invalid --" + label + ": " + value);
  }
  return n;
}

function options(args) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      factorio: { type: "string" },
      "data-dir": { type: "string" },
      game: { type: "string" },
      "output-dir": { type: "string" },
      timeout: { type: "string" },
      "pixels-per-tile": { type: "string" },
      padding: { type: "string" },
      "no-alt": { type: "boolean" },
      overwrite: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, inputPath, ...additional] = parsed.positionals;
  if (parsed.values.help || args.length === 0) return null;
  if (!["validate", "render"].includes(command) || !inputPath || additional.length) {
    throw new Error("Expected validate or render followed by one blueprint path. Use --help.");
  }
  const render = command === "render";
  const game = parsed.values.game ?? "base";
  if (!["base", "space-age"].includes(game)) throw new Error("Use --game base or --game space-age.");
  if (render && !windows) throw new Error("Native render currently supports a Windows graphics client.");
  if (render && !parsed.values["output-dir"]) throw new Error("render requires --output-dir.");
  return {
    command,
    inputPath: resolve(inputPath),
    game,
    render,
    executableOverride: parsed.values.factorio ?? process.env.FACTORIO_EXE,
    dataOverride: parsed.values["data-dir"],
    outputDir: parsed.values["output-dir"] ? resolve(parsed.values["output-dir"]) : undefined,
    timeoutMs: numberOption(parsed.values.timeout, render ? 60 : 30, "timeout", 1) * 1000,
    pixelsPerTile: numberOption(parsed.values["pixels-per-tile"], 24, "pixels-per-tile", 1, 128),
    padding: numberOption(parsed.values.padding, 4, "padding", 2),
    altMode: !parsed.values["no-alt"],
    overwrite: Boolean(parsed.values.overwrite),
  };
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function executablePath(override) {
  if (override) {
    const path = resolve(override);
    if (!(await isFile(path))) throw new Error("Factorio executable not found: " + path);
    return realpath(path);
  }
  const programFiles = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  const steamRoots = [...programFiles.map((p) => join(p, "Steam")), "D:/Steam"];
  const steamCandidates = windows
    ? steamRoots.map((p) => join(p, "steamapps", "common", "Factorio", "bin", "x64", "factorio.exe"))
    : [];
  const program = windows ? "factorio.exe" : "factorio";
  const pathCandidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
    .map((directory) => join(directory.replace(/^"|"$/g, ""), program));
  for (const candidate of [...steamCandidates, ...pathCandidates]) {
    if (await isFile(candidate)) return realpath(candidate);
  }
  throw new Error("Could not locate Factorio. Pass its full executable path with --factorio or FACTORIO_EXE.");
}

async function dataPath(executable, override) {
  const binaryDirectory = dirname(executable);
  const candidates = override ? [resolve(override)] : [
    resolve(binaryDirectory, "..", "..", "data"),
    resolve(binaryDirectory, "..", "data"),
  ];
  for (const candidate of candidates) {
    if (await isFile(join(candidate, "base", "info.json"))) return realpath(candidate);
  }
  throw new Error("Could not locate the Factorio data folder. Use --data-dir.");
}

function blueprintBounds(entries) {
  if (!entries.length) return undefined;
  const result = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { position } of entries) {
    result.minX = Math.min(result.minX, position.x);
    result.minY = Math.min(result.minY, position.y);
    result.maxX = Math.max(result.maxX, position.x);
    result.maxY = Math.max(result.maxY, position.y);
  }
  return result;
}

async function readBlueprint(path) {
  const bytes = await readFile(path);
  const source = bytes.toString("utf8").trim();
  const encoded = source[0] === "0";
  if (!encoded && source[0] !== "{") throw new Error("Expected one Factorio exchange string or blueprint JSON.");
  const json = encoded ? inflateSync(Buffer.from(source.slice(1), "base64")).toString("utf8") : source;
  const blueprint = JSON.parse(json).blueprint;
  if (!blueprint) throw new Error("Input must be one blueprint. Extract a page separately from a blueprint book.");
  const entities = blueprint.entities ?? [];
  const tiles = blueprint.tiles ?? [];
  if (!Array.isArray(entities) || !Array.isArray(tiles) || entities.length + tiles.length === 0) {
    throw new Error("The blueprint needs placement entities or tiles.");
  }
  for (const list of [entities, tiles]) {
    for (const entry of list) {
      if (typeof entry?.name !== "string" || !Number.isFinite(entry.position?.x) || !Number.isFinite(entry.position?.y)) {
        throw new Error("A blueprint entry has no name or finite position.");
      }
    }
  }
  return {
    source,
    hash: createHash("sha256").update(bytes).digest("hex"),
    entities: entities.map(({ name, position: { x, y }, direction }) => ({ name, position: { x, y }, direction })),
    tiles: tiles.map(({ name, position: { x, y } }) => ({ name, position: { x, y } })),
    entityBounds: blueprintBounds(entities),
    tileBounds: blueprintBounds(tiles),
  };
}

function luaString(text) {
  let equals = "";
  while (text.includes("]" + equals + "]")) equals += "=";
  return "[" + equals + "[" + text + "]" + equals + "]";
}

function run(executable, args, cwd) {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const processState = { child, logs: "", result: undefined };
  const append = (text) => { processState.logs = (processState.logs + text).slice(-24000); };
  child.stdout.setEncoding("utf8").on("data", append);
  child.stderr.setEncoding("utf8").on("data", append);
  processState.completion = new Promise((done) => {
    child.once("error", (error) => {
      processState.result = { error };
      done(processState.result);
    });
    child.once("close", (code, signal) => {
      processState.result ??= { code, signal };
      done(processState.result);
    });
  });
  return processState;
}

async function stop(processState) {
  if (!processState || processState.result) return;
  processState.child.kill();
  await Promise.race([processState.completion, sleep(500)]);
  if (!processState.result) processState.child.kill("SIGKILL");
}

function engineDiagnostic(processState) {
  return processState.logs.split(/\r?\n/)
    .filter((line) => line && !/SteamID|Steam ID|auth token|service-token/i.test(line))
    .slice(-12).join("\n");
}

async function getVersion(executable, cwd) {
  const processState = run(executable, ["--version"], cwd);
  try {
    await Promise.race([processState.completion, sleep(5000, undefined, { ref: false })]);
    const match = processState.logs.match(/Version:\s+(\d+)\.(\d+)\.(\d+)(?:\s+\(([^\r\n)]+)\))?/);
    if (processState.result?.error) throw processState.result.error;
    if (!match) throw new Error("Factorio did not report its version.");
    const [, major, minor, patch, build] = match;
    if (Number(major) < 2 || (Number(major) === 2 && (Number(minor) < 1 || (Number(minor) === 1 && Number(patch) < 24)))) {
      throw new Error("Factorio 2.1.24 or later is required for native scenario validation.");
    }
    return { version: [major, minor, patch].join("."), build };
  } finally {
    await stop(processState);
  }
}

async function scratchFiles(scratch, data, blueprint, settings, build) {
  const scenario = join(scratch, "scenarios", "codex-blueprint");
  const mods = join(scratch, "mods");
  await Promise.all([mkdir(scenario, { recursive: true }), mkdir(mods, { recursive: true })]);
  const useExpansion = settings.game === "space-age";
  const modList = ["base", "quality", "elevated-rails", "recycler", "space-age"]
    .map((name) => ({ name, enabled: name === "base" || useExpansion }));
  if (useExpansion && !(await isFile(join(data, "space-age", "info.json")))) {
    throw new Error("The configured Factorio data folder has no Space Age prototypes.");
  }
  const { source, entities, tiles, entityBounds, tileBounds } = blueprint;
  const spec = { entities, tiles, entityBounds, tileBounds, command: settings.command, padding: settings.padding, pixelsPerTile: settings.pixelsPerTile, altMode: settings.altMode };
  const config = [
    "[path]", "read-data=" + data.replaceAll("\\", "/"), "write-data=" + scratch.replaceAll("\\", "/"), "",
  ].join("\n");
  const files = [
    writeFile(join(scratch, "config.ini"), config),
    writeFile(join(mods, "mod-list.json"), JSON.stringify({ mods: modList })),
    copyFile(luaTemplate, join(scenario, "control.lua")),
    writeFile(join(scenario, "fixture.lua"), "return {blueprint=" + luaString(source) + ",spec=" + luaString(JSON.stringify(spec)) + "}\n"),
  ];
  if (windows && settings.render && build?.includes("steam")) {
    // Steamworks looks in the child working directory for its App ID when starting directly.
    // This identifies the installed app to the running Steam client using its existing license.
    files.push(writeFile(join(scratch, "steam_appid.txt"), "427520"));
  }
  await Promise.all(files);
}

async function readReport(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") return undefined;
    throw error;
  }
}

async function readScreenshot(path, report) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!bytes.subarray(0, 8).equals(pngSignature) || !bytes.subarray(-pngEnding.length).equals(pngEnding)) return undefined;
  if (bytes.readUInt32BE(16) !== report.pixelWidth || bytes.readUInt32BE(20) !== report.pixelHeight) {
    throw new Error("Native PNG dimensions differ from the coordinate manifest.");
  }
  return bytes;
}

async function waitForResult(processState, scratch, settings) {
  const directory = join(scratch, "script-output");
  const deadline = Date.now() + settings.timeoutMs;
  for (;;) {
    const report = await readReport(join(directory, "native-result.json"));
    if (report && settings.render) {
      if (!report.pass) return { report };
      const screenshot = await readScreenshot(join(directory, "native-blueprint.png"), report);
      if (screenshot) return { report, screenshot };
    }
    if (processState.result) {
      if (processState.result.error) throw processState.result.error;
      if (report && !settings.render) {
        if ((processState.result.code === 0) !== report.pass) {
          throw new Error("Factorio process exit status disagreed with the placement report.");
        }
        return { report };
      }
      throw new Error("Factorio exited before producing a complete native result.\n" + engineDiagnostic(processState));
    }
    if (Date.now() >= deadline) {
      throw new Error("Factorio did not complete within " + (settings.timeoutMs / 1000) + " seconds.\n" + engineDiagnostic(processState));
    }
    await sleep(200);
  }
}

async function writeOutputs(settings, report, screenshot) {
  if (!settings.outputDir || (settings.render && !report.pass)) return;
  const directory = settings.outputDir;
  const reportName = settings.render ? "native-blueprint.json" : "native-validation.json";
  const items = [
    ...(screenshot ? [["native-blueprint.png", screenshot]] : []),
    [reportName, JSON.stringify(report, null, 2) + "\n"],
  ];
  await mkdir(directory, { recursive: true });
  if (!settings.overwrite) {
    for (const [name] of items) {
      const outputPath = join(directory, name);
      const exists = await access(outputPath).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) throw new Error("Output already exists: " + outputPath + ". Use --overwrite or another output directory.");
    }
  }
  for (const [name, content] of items) {
    await writeFile(join(directory, name), content, { flag: settings.overwrite ? "w" : "wx" });
  }
}

async function cleanup(scratch, parent) {
  const actual = await realpath(scratch);
  if (dirname(actual) !== parent || !basename(actual).startsWith(prefix)) {
    throw new Error("Refused to clean an unexpected Factorio temporary directory: " + actual);
  }
  await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function main(args) {
  const settings = options(args);
  if (!settings) return console.log(help);
  const [executable, blueprint, parent] = await Promise.all([
    executablePath(settings.executableOverride),
    readBlueprint(settings.inputPath),
    realpath(tmpdir()),
  ]);
  const data = await dataPath(executable, settings.dataOverride);
  const scratch = await mkdtemp(join(parent, prefix));
  let processState;
  try {
    const { version, build } = await getVersion(executable, scratch);
    await scratchFiles(scratch, data, blueprint, settings, build);
    const configArgs = ["--config", join(scratch, "config.ini"), "--mod-directory", join(scratch, "mods")];
    const scenarioArgs = settings.render
      ? ["--load-scenario", "codex-blueprint", "--disable-audio", "--fullscreen=false", "--window-size", "640x480"]
      : ["--test-scenario", "codex-blueprint", "--test-ticks", "240"];
    processState = run(executable, [...configArgs, ...scenarioArgs], scratch);
    const { report, screenshot } = await waitForResult(processState, scratch, settings);
    Object.assign(report, { engineVersion: version, engineBuild: build, game: settings.game, blueprintSha256: blueprint.hash });
    await writeOutputs(settings, report, screenshot);
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    await stop(processState);
    await cleanup(scratch, parent);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});