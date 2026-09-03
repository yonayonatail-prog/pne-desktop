import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  buildEditablePnepack,
  buildPnePackage,
  readStoredZip,
  scanProject,
  type ProjectFile,
  type PnePackIssue
} from "../packages/pne-pack/src";
import type { PneLicense } from "../packages/pne-schema/src";

const decoder = new TextDecoder();

function usage(): never {
  console.error(`P.N.E. パッケージツール

使い方:
  npm run pne -- check <作品フォルダ> [--json]
  npm run pne -- pack <作品フォルダ> --editable|--runtime [出力先]
  npm run pne -- inspect <.pnepack/.pne> [--json]

作品フォルダには pne_statekit_pack.json と assets/ を置きます。
asset_manifest.json は手で作成する必要はありません。
`);
  process.exit(2);
}

function hasFlag(args: string[], flag: string): boolean { return args.includes(flag); }

function withoutFlags(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("--"));
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try { return JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, "")) as unknown; }
  catch (error) { throw new Error(`${path}: JSONを読み込めません（${error instanceof Error ? error.message : String(error)}）`); }
}

async function walk(root: string, current = root): Promise<ProjectFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: ProjectFile[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: new Uint8Array(await readFile(path)) });
  }
  return files;
}

async function loadProject(folder: string) {
  const root = resolve(folder);
  const files = await walk(root);
  const statekitFile = files.find((file) => file.path === "pne_statekit_pack.json");
  if (!statekitFile) throw new Error("pne_statekit_pack.jsonが見つかりません。作品フォルダを指定してください。");
  const licenseFile = files.find((file) => file.path === "license.json");
  const license = licenseFile ? parseJson(licenseFile.bytes, "license.json") as PneLicense : undefined;
  return { root, files, statekitPack: parseJson(statekitFile.bytes, "pne_statekit_pack.json"), license };
}

function printIssues(issues: PnePackIssue[]): void {
  for (const item of issues) {
    const location = item.path ? ` (${item.path})` : "";
    console.log(`${item.level === "error" ? "ERROR" : "WARN"} ${item.code}: ${item.message}${location}`);
  }
}

function diagnosticReport(scanned: Awaited<ReturnType<typeof scanProject>>) {
  return {
    tool: "pne-cli",
    package_format: "pnepack/1.0",
    work_id: scanned.workId,
    title: scanned.title,
    work_version: scanned.workVersion,
    asset_count: scanned.assetsFile.assets.length,
    slot_count: scanned.assetManifest.slots.length,
    missing_slot_count: scanned.assetManifest.slots.filter((slot) => slot.status === "missing").length,
    errors: scanned.issues.filter((item) => item.level === "error").length,
    warnings: scanned.issues.filter((item) => item.level === "warning").length,
    issues: scanned.issues
  };
}

async function check(folder: string, json: boolean): Promise<number> {
  const input = await loadProject(folder);
  const scanned = await scanProject(input);
  if (json) console.log(JSON.stringify(diagnosticReport(scanned), null, 2));
  else {
    console.log(`${scanned.title} (${scanned.workId})`);
    console.log(`素材 ${scanned.assetsFile.assets.length}件 / スロット ${scanned.assetManifest.slots.length}件`);
    printIssues(scanned.issues);
    if (!scanned.issues.length) console.log("OK: 完成版.pneを書き出せます");
  }
  return scanned.issues.some((item) => item.level === "error") ? 1 : 0;
}

async function pack(folder: string, args: string[]): Promise<number> {
  const input = await loadProject(folder);
  const editable = hasFlag(args, "--editable");
  const runtime = hasFlag(args, "--runtime");
  if (editable === runtime) throw new Error("--editable または --runtime のどちらか一つを指定してください。");
  const positional = withoutFlags(args);
  const output = resolve(positional[1] ?? join(input.root, `${basename(input.root)}${editable ? ".pnepack" : ".pne"}`));
  const built = editable ? await buildEditablePnepack(input) : await buildPnePackage(input);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, built.archive);
  printIssues(built.issues);
  console.log(`${editable ? "編集用" : "完成版"}パッケージを書き出しました: ${output}`);
  return 0;
}

async function inspectArchive(path: string, json: boolean): Promise<number> {
  const archive = new Uint8Array(await readFile(resolve(path)));
  const entries = readStoredZip(archive);
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  const manifest = manifestEntry ? parseJson(manifestEntry.bytes, "manifest.json") : null;
  const result = { path: resolve(path), bytes: archive.byteLength, entries: entries.map((entry) => ({ path: entry.path, bytes: entry.bytes.byteLength })), manifest };
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${resolve(path)} (${archive.byteLength} bytes)`);
    for (const entry of result.entries) console.log(`${entry.path} ${entry.bytes} bytes`);
  }
  return 0;
}

const args = process.argv.slice(2);
const command = args[0];
const json = hasFlag(args, "--json");
try {
  if (command === "check" && args[1]) process.exitCode = await check(args[1], json);
  else if (command === "pack" && args[1]) process.exitCode = await pack(args[1], args.slice(1));
  else if (command === "inspect" && args[1]) process.exitCode = await inspectArchive(args[1], json);
  else usage();
} catch (error) {
  console.error(`ERROR E-CLI-001: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
