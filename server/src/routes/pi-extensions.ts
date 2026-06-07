import type { FastifyInstance } from "fastify";
import fs from "fs-extra";
import path from "node:path";
import { z } from "zod";
import { store } from "../core/store.js";
import { badRequest, notFound } from "../core/errors.js";
import { dockerService } from "../docker/docker-service.js";
import { materializeBoxPiConfig, PI_AGENT_DIR_IN_CONTAINER } from "../agent/pi-config.js";
import { PI_BIN_IN_CONTAINER } from "../agent/pi-args.js";
import { ensureCompatiblePiCli } from "../agent/pi-version.js";

export interface PiExtensionRecord {
  name: string;
  scope: "box" | "workspace";
  path: string;
  type: "file" | "directory" | "package" | "path";
  entrypoint?: string;
  source?: string;
  size: number;
  modifiedAt: string;
}

const SourceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  source: z.string().min(1),
  scope: z.enum(["box", "workspace"]).default("box"),
  cwd: z.string().default("/workspace"),
  overwrite: z.boolean().default(false)
});

const RemoveSchema = z.object({
  source: z.string().min(1),
  scope: z.enum(["box", "workspace"]).default("box"),
  cwd: z.string().default("/workspace")
});

const UploadSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  scope: z.enum(["box", "workspace"]).default("box"),
  cwd: z.string().default("/workspace"),
  overwrite: z.coerce.boolean().default(false)
});

const MigrateSchema = z.object({
  targetBoxIds: z.array(z.string().min(1)).min(1),
  names: z.array(z.string().min(1)).optional(),
  sourceScope: z.enum(["box", "workspace"]).default("box"),
  targetScope: z.enum(["box", "workspace"]).default("box"),
  sourceCwd: z.string().default("/workspace"),
  targetCwd: z.string().default("/workspace"),
  overwrite: z.boolean().default(false)
});

export async function registerPiExtensionRoutes(app: FastifyInstance) {
  app.get("/api/boxes/:boxId/pi-extensions", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const query = z.object({ cwd: z.string().default("/workspace") }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    return { extensions: await listExtensions(box, query.cwd) };
  });

  app.post("/api/boxes/:boxId/pi-extensions/install", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = SourceSchema.parse(req.body ?? {});
    const box = store.getBox(boxId);
    const result = await installFromSource(box, body);
    return { ok: true, extension: result, message: reloadHint(result.scope) };
  });

  app.post("/api/boxes/:boxId/pi-extensions/upload", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const query = UploadSchema.parse(req.query ?? {});
    const file = await req.file();
    if (!file) throw badRequest("missing file");
    const chunks: Buffer[] = [];
    for await (const chunk of file.file) chunks.push(Buffer.from(chunk));
    const sourceName = query.name ?? file.filename;
    const ext = await writeUploadedExtension(boxId, sourceName, Buffer.concat(chunks), query);
    return { ok: true, extension: ext, message: reloadHint(ext.scope) };
  });

  app.delete("/api/boxes/:boxId/pi-extensions/:scope/:name", async (req) => {
    const { boxId, scope, name } = z.object({ boxId: z.string(), scope: z.enum(["box", "workspace"]), name: z.string().min(1) }).parse(req.params);
    const query = z.object({ cwd: z.string().default("/workspace") }).parse(req.query ?? {});
    const box = store.getBox(boxId);
    const target = path.join(extensionsHostDir(box, scope, query.cwd), sanitizeExtensionName(name));
    await assertInsideWorkspace(box, target);
    if (!(await fs.pathExists(target))) throw notFound("extension not found");
    await fs.remove(target);
    return { ok: true, message: reloadHint(scope) };
  });

  app.post("/api/boxes/:boxId/pi-extensions/pi-remove", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = RemoveSchema.parse(req.body ?? {});
    const box = store.getBox(boxId);
    await dockerService.start(box);
    await ensureCompatiblePiCli(box);
    await materializeBoxPiConfig(box);
    const cwd = normalizeContainerCwd(body.cwd);
    const args = [PI_BIN_IN_CONTAINER, "remove", body.source];
    if (body.scope === "workspace") args.push("-l");
    const result = await dockerService.exec(box, args, { cwd, env: [`PI_CODING_AGENT_DIR=${PI_AGENT_DIR_IN_CONTAINER}`, "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0"] });
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "pi remove failed");
    return { ok: true, stdout: result.stdout, stderr: result.stderr, message: reloadHint(body.scope) };
  });

  app.post("/api/boxes/:boxId/pi-extensions/migrate", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = MigrateSchema.parse(req.body ?? {});
    const sourceBox = store.getBox(boxId);
    const sourceDir = extensionsHostDir(sourceBox, body.sourceScope, body.sourceCwd);
    const available = await listExtensions(sourceBox, body.sourceCwd);
    const selected = body.names?.length ? available.filter((ext) => ext.scope === body.sourceScope && body.names!.includes(ext.name)) : available.filter((ext) => ext.scope === body.sourceScope);
    if (selected.length === 0) throw badRequest("no extensions selected");

    const migrated: Array<{ targetBoxId: string; extensions: PiExtensionRecord[] }> = [];
    for (const targetBoxId of body.targetBoxIds) {
      if (targetBoxId === boxId) continue;
      const targetBox = store.getBox(targetBoxId);
      const targetDir = extensionsHostDir(targetBox, body.targetScope, body.targetCwd);
      await fs.ensureDir(targetDir);
      const copied: PiExtensionRecord[] = [];
      for (const ext of selected) {
        const src = path.join(sourceDir, ext.name);
        const dst = path.join(targetDir, ext.name);
        await copyExtensionPath(src, dst, body.overwrite);
        copied.push(await statExtension(targetBox, dst, body.targetScope));
      }
      migrated.push({ targetBoxId, extensions: copied });
    }
    return { ok: true, migrated, message: "迁移完成。目标 Box 中正在运行的 pi session 需要 /reload 或重启后生效。" };
  });

  app.post("/api/boxes/:boxId/pi-extensions/pi-install", async (req) => {
    const { boxId } = req.params as { boxId: string };
    const body = SourceSchema.parse(req.body ?? {});
    const box = store.getBox(boxId);
    await dockerService.start(box);
    await ensureCompatiblePiCli(box);
    await materializeBoxPiConfig(box);
    const cwd = normalizeContainerCwd(body.cwd);
    const args = [PI_BIN_IN_CONTAINER, "install", body.source];
    if (body.scope === "workspace") args.push("-l");
    const result = await dockerService.exec(box, args, { cwd, env: [`PI_CODING_AGENT_DIR=${PI_AGENT_DIR_IN_CONTAINER}`, "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0"] });
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "pi install failed");
    return { ok: true, stdout: result.stdout, stderr: result.stderr, message: reloadHint(body.scope) };
  });
}

async function listExtensions(box: { workspacePath: string }, cwd: string): Promise<PiExtensionRecord[]> {
  const dirs: Array<{ scope: "box" | "workspace"; dir: string }> = [
    { scope: "box", dir: extensionsHostDir(box, "box", cwd) },
    { scope: "workspace", dir: extensionsHostDir(box, "workspace", cwd) }
  ];
  const all: PiExtensionRecord[] = [];
  for (const item of dirs) {
    if (!(await fs.pathExists(item.dir))) continue;
    const names = (await fs.readdir(item.dir)).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const full = path.join(item.dir, name);
      if (!(await isDiscoverableExtension(full))) continue;
      all.push(await statExtension(box, full, item.scope));
    }
  }
  all.push(...await listConfiguredExtensionSources(box, cwd));
  return all;
}

async function listConfiguredExtensionSources(box: { workspacePath: string }, cwd: string): Promise<PiExtensionRecord[]> {
  const items: PiExtensionRecord[] = [];
  const configs: Array<{ scope: "box" | "workspace"; file: string }> = [
    { scope: "box", file: path.join(box.workspacePath, ".boxedagent", "pi-agent", "settings.json") },
    { scope: "workspace", file: path.join(workspaceHostPath(box, cwd), ".pi", "settings.json") }
  ];
  for (const config of configs) {
    const settings = await fs.readJson(config.file).catch(() => undefined) as any;
    if (!settings || typeof settings !== "object") continue;
    const mtime = await fs.stat(config.file).then((st) => new Date(st.mtimeMs).toISOString()).catch(() => new Date().toISOString());
    for (const source of normalizeSourceArray(settings.packages)) {
      items.push({ name: packageDisplayName(source), scope: config.scope, path: source, type: "package", size: 0, modifiedAt: mtime, source });
    }
    for (const source of normalizeSourceArray(settings.extensions)) {
      items.push({ name: path.basename(source), scope: config.scope, path: source, type: "path", size: 0, modifiedAt: mtime, source });
    }
  }
  return dedupeRecords(items);
}

function normalizeSourceArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (entry && typeof entry === "object" && typeof (entry as any).source === "string" && (entry as any).source.trim()) return [(entry as any).source.trim()];
    return [];
  });
}

function packageDisplayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4).replace(/@[^/@]+$/, "") || source;
  if (source.startsWith("git:")) return source.slice(4).split(/[?#]/, 1)[0];
  return source;
}

function dedupeRecords(records: PiExtensionRecord[]): PiExtensionRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.scope}:${record.type}:${record.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function installFromSource(box: { workspacePath: string }, body: z.infer<typeof SourceSchema>): Promise<PiExtensionRecord> {
  const targetDir = extensionsHostDir(box, body.scope, body.cwd);
  await fs.ensureDir(targetDir);
  const source = resolveSourceHostPath(box, body.source);
  if (!(await fs.pathExists(source))) throw notFound("source extension not found");
  if (!(await isDiscoverableExtension(source))) throw badRequest("source must be a .ts/.js extension file or a directory containing index.ts/index.js");
  const name = sanitizeExtensionName(body.name ?? path.basename(source));
  const target = path.join(targetDir, normalizeExtensionTargetName(name, source));
  await copyExtensionPath(source, target, body.overwrite);
  return statExtension(box, target, body.scope);
}

async function writeUploadedExtension(boxId: string, name: string, content: Buffer, query: z.infer<typeof UploadSchema>): Promise<PiExtensionRecord> {
  const box = store.getBox(boxId);
  const targetDir = extensionsHostDir(box, query.scope, query.cwd);
  await fs.ensureDir(targetDir);
  const safe = sanitizeExtensionName(name);
  if (!/\.(ts|js)$/i.test(safe)) throw badRequest("uploaded extension filename must end with .ts or .js");
  const target = path.join(targetDir, safe);
  if (!query.overwrite && await fs.pathExists(target)) throw badRequest("extension already exists; enable overwrite to replace it");
  await assertInsideWorkspace(box, target);
  await fs.writeFile(target, content);
  return statExtension(box, target, query.scope);
}

async function copyExtensionPath(source: string, target: string, overwrite: boolean): Promise<void> {
  if (!overwrite && await fs.pathExists(target)) throw badRequest("extension already exists; enable overwrite to replace it");
  await fs.remove(target);
  await fs.copy(source, target, { overwrite: true, errorOnExist: false, dereference: false });
}

async function statExtension(box: { workspacePath: string }, fullPath: string, scope: "box" | "workspace"): Promise<PiExtensionRecord> {
  await assertInsideWorkspace(box, fullPath);
  const st = await fs.stat(fullPath);
  const rel = path.relative(box.workspacePath, fullPath).split(path.sep).join("/");
  return {
    name: path.basename(fullPath),
    scope,
    path: `/workspace/${rel}`,
    type: st.isDirectory() ? "directory" : "file",
    entrypoint: st.isDirectory() ? await findEntrypoint(fullPath) : undefined,
    size: st.size,
    modifiedAt: new Date(st.mtimeMs).toISOString()
  };
}

function extensionsHostDir(box: { workspacePath: string }, scope: "box" | "workspace", cwd: string): string {
  if (scope === "box") return path.join(box.workspacePath, ".boxedagent", "pi-agent", "extensions");
  return path.join(workspaceHostPath(box, cwd), ".pi", "extensions");
}

function resolveSourceHostPath(box: { workspacePath: string }, source: string): string {
  const trimmed = source.trim();
  if (!trimmed) throw badRequest("missing source");
  if (trimmed.startsWith("/workspace")) return workspaceHostPath(box, trimmed);
  if (trimmed.startsWith(".")) return workspaceHostPath(box, path.posix.join("/workspace", trimmed));
  return workspaceHostPath(box, path.posix.join("/workspace", trimmed));
}

function workspaceHostPath(box: { workspacePath: string }, containerPath: string): string {
  const normalized = normalizeContainerCwd(containerPath);
  const rel = normalized.slice("/workspace".length).replace(/^\/+/, "");
  const base = path.resolve(box.workspacePath);
  const target = path.resolve(base, rel);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw badRequest("path escapes workspace");
  return target;
}

async function assertInsideWorkspace(box: { workspacePath: string }, target: string): Promise<void> {
  const base = path.resolve(box.workspacePath);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw badRequest("path escapes workspace");
}

function normalizeContainerCwd(cwd: string): string {
  const value = cwd.trim() || "/workspace";
  const normalized = path.posix.normalize(value.startsWith("/workspace") ? value : path.posix.join("/workspace", value));
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) throw badRequest("cwd must be inside /workspace");
  return normalized;
}

function sanitizeExtensionName(name: string): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") throw badRequest("invalid extension name");
  if (safe.includes("..")) throw badRequest("invalid extension name");
  return safe;
}

function normalizeExtensionTargetName(name: string, source: string): string {
  if (/\.(ts|js)$/i.test(path.basename(source)) && !/\.(ts|js)$/i.test(name)) return `${name}${path.extname(source)}`;
  return name;
}

async function isDiscoverableExtension(fullPath: string): Promise<boolean> {
  const st = await fs.stat(fullPath).catch(() => undefined);
  if (!st) return false;
  if (st.isFile()) return /\.(ts|js)$/i.test(fullPath);
  if (!st.isDirectory()) return false;
  return Boolean(await findEntrypoint(fullPath));
}

async function findEntrypoint(dir: string): Promise<string | undefined> {
  for (const name of ["index.ts", "index.js"]) {
    if (await fs.pathExists(path.join(dir, name))) return name;
  }
  return undefined;
}

function reloadHint(scope: "box" | "workspace"): string {
  return `${scope === "box" ? "Box 全局" : "工作区"} extension 已安装。正在运行的 pi session 需要发送 /reload 或重启后生效。`;
}
