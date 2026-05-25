import fs from "fs-extra";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { BoxRecord, PiLoadedResourceItem, PiLoadedResources, PiResourceScope } from "../core/types.js";
import { store } from "../core/store.js";

interface SettingsSource {
  scope: "box" | "workspace";
  file: string;
  baseDir: string;
  settings: Record<string, unknown>;
}

interface SourceEntry {
  source: string;
  filtered?: boolean;
}

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_RESOURCE_ITEMS_PER_SECTION = 80;

export async function getPiLoadedResourcesForSession(sessionId: string, options: { reason?: PiLoadedResources["reason"] } = {}): Promise<PiLoadedResources> {
  const session = store.getSession(sessionId);
  const box = store.getBox(session.boxId);
  return collectPiLoadedResources(box, session.cwd, options);
}

export async function collectPiLoadedResources(box: BoxRecord, sessionCwd?: string, options: { reason?: PiLoadedResources["reason"] } = {}): Promise<PiLoadedResources> {
  const cwd = normalizeContainerCwd(sessionCwd);
  const diagnostics: string[] = [];
  const settingsSources = await loadSettingsSources(box, cwd, diagnostics);

  const contextFiles = await discoverContextFiles(box, cwd, diagnostics);
  const packages = collectConfiguredPackages(settingsSources);
  const extensions = dedupeItems([
    ...await discoverExtensions(box, cwd, diagnostics),
    ...collectConfiguredPathResources(settingsSources, "extensions", "extension", diagnostics)
  ]);
  const skills = dedupeItems([
    ...await discoverDefaultSkills(box, cwd, diagnostics),
    ...await collectConfiguredLocalResources(box, cwd, settingsSources, "skills", "skill", diagnostics)
  ]);
  const prompts = dedupeItems([
    ...await discoverDefaultPrompts(box, cwd, diagnostics),
    ...await collectConfiguredLocalResources(box, cwd, settingsSources, "prompts", "prompt", diagnostics)
  ]);
  const themes = dedupeItems([
    ...await discoverDefaultThemes(box, cwd, diagnostics),
    ...await collectConfiguredLocalResources(box, cwd, settingsSources, "themes", "theme", diagnostics)
  ]);

  return {
    cwd,
    reason: options.reason,
    generatedAt: new Date().toISOString(),
    contextFiles: limitItems(dedupeItems(contextFiles)),
    packages: limitItems(dedupeItems(packages)),
    extensions: limitItems(extensions),
    skills: limitItems(skills),
    prompts: limitItems(prompts),
    themes: limitItems(themes),
    diagnostics: [...new Set(diagnostics)].slice(0, 80)
  };
}

async function discoverContextFiles(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const items: PiLoadedResourceItem[] = [];
  const seen = new Set<string>();
  const agentDir = boxAgentDir(box);
  const globalContext = await readFirstContextFile(agentDir, diagnostics);
  if (globalContext) {
    items.push({ name: path.basename(globalContext.path), path: toContainerPath(box, globalContext.path), scope: "box", kind: "context", size: globalContext.size });
    seen.add(path.resolve(globalContext.path));
  }

  const workspaceRoot = path.resolve(box.workspacePath);
  const cwdHost = workspaceHostPath(box, cwd);
  const dirs: string[] = [];
  let current = path.resolve(cwdHost);
  while (true) {
    if (current === workspaceRoot || path.relative(workspaceRoot, current).startsWith("..") || path.isAbsolute(path.relative(workspaceRoot, current))) {
      dirs.unshift(workspaceRoot);
      break;
    }
    dirs.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const dir of dirs) {
    const contextFile = await readFirstContextFile(dir, diagnostics);
    if (!contextFile) continue;
    const resolved = path.resolve(contextFile.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    items.push({ name: path.basename(contextFile.path), path: toContainerPath(box, contextFile.path), scope: "workspace", kind: "context", size: contextFile.size });
  }
  return items;
}

async function readFirstContextFile(dir: string, diagnostics: string[]): Promise<{ path: string; size: number } | undefined> {
  for (const name of CONTEXT_FILE_NAMES) {
    const file = path.join(dir, name);
    const st = await fs.stat(file).catch(() => undefined);
    if (!st?.isFile()) continue;
    try {
      await fs.access(file, fs.constants.R_OK);
      return { path: file, size: st.size };
    } catch (error) {
      diagnostics.push(`无法读取上下文文件 ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return undefined;
}

async function discoverExtensions(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const sources = [
    { scope: "box" as const, dir: path.join(boxAgentDir(box), "extensions") },
    { scope: "workspace" as const, dir: path.join(workspaceHostPath(box, cwd), ".pi", "extensions") }
  ];
  const items: PiLoadedResourceItem[] = [];
  for (const source of sources) {
    if (!(await fs.pathExists(source.dir))) continue;
    let names: string[];
    try {
      names = (await fs.readdir(source.dir)).sort((a, b) => a.localeCompare(b));
    } catch (error) {
      diagnostics.push(`无法读取 extensions 目录 ${source.dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const name of names) {
      const full = path.join(source.dir, name);
      const st = await fs.stat(full).catch(() => undefined);
      if (!st) continue;
      if (st.isFile() && /\.(ts|js)$/i.test(name)) {
        items.push({ name, path: toContainerPath(box, full), scope: source.scope, kind: "extension", type: "file", size: st.size });
        continue;
      }
      if (st.isDirectory()) {
        const entrypoint = await findEntrypoint(full);
        if (entrypoint) items.push({ name, path: toContainerPath(box, full), scope: source.scope, kind: "extension", type: "directory", entrypoint });
      }
    }
  }
  return items;
}

function collectConfiguredPackages(settingsSources: SettingsSource[]): PiLoadedResourceItem[] {
  const items: PiLoadedResourceItem[] = [];
  for (const settingsSource of settingsSources) {
    for (const entry of normalizeSourceEntries(settingsSource.settings.packages)) {
      items.push({
        name: packageDisplayName(entry.source),
        path: entry.source,
        source: entry.source,
        scope: settingsSource.scope,
        kind: "package",
        type: entry.filtered ? "filtered" : "package"
      });
    }
  }
  return items;
}

function collectConfiguredPathResources(settingsSources: SettingsSource[], field: "extensions", kind: PiLoadedResourceItem["kind"], diagnostics: string[]): PiLoadedResourceItem[] {
  const items: PiLoadedResourceItem[] = [];
  for (const settingsSource of settingsSources) {
    for (const entry of normalizeSourceEntries(settingsSource.settings[field])) {
      const resolved = resolveConfiguredPath(settingsSource.baseDir, entry.source);
      if (resolved && !fs.pathExistsSync(resolved)) diagnostics.push(`${field} 路径不存在: ${entry.source}`);
      items.push({
        name: path.basename(entry.source.replace(/[\\/]+$/, "")) || entry.source,
        path: resolved ? toContainerPathIfInside(settingsSource, resolved) ?? entry.source : entry.source,
        source: entry.source,
        scope: settingsSource.scope,
        kind,
        type: "path"
      });
    }
  }
  return items;
}

async function discoverDefaultSkills(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const cwdHost = workspaceHostPath(box, cwd);
  const roots: Array<{ scope: PiResourceScope; dir: string; includeRootMd: boolean }> = [
    { scope: "box", dir: path.join(boxAgentDir(box), "skills"), includeRootMd: true },
    { scope: "workspace", dir: path.join(cwdHost, ".pi", "skills"), includeRootMd: true }
  ];
  for (const dir of ancestorDirs(box, cwdHost)) roots.push({ scope: "workspace", dir: path.join(dir, ".agents", "skills"), includeRootMd: false });

  const items: PiLoadedResourceItem[] = [];
  for (const root of roots) items.push(...await discoverSkillsFromDir(box, root.dir, root.scope, root.includeRootMd, diagnostics));
  return items;
}

async function collectConfiguredLocalResources(box: BoxRecord, cwd: string, settingsSources: SettingsSource[], field: "skills" | "prompts" | "themes", kind: PiLoadedResourceItem["kind"], diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const items: PiLoadedResourceItem[] = [];
  for (const settingsSource of settingsSources) {
    for (const entry of normalizeSourceEntries(settingsSource.settings[field])) {
      const resolved = resolveConfiguredPath(settingsSource.baseDir, entry.source);
      if (!resolved) {
        items.push({ name: path.basename(entry.source) || entry.source, path: entry.source, source: entry.source, scope: settingsSource.scope, kind, type: "path" });
        continue;
      }
      const st = await fs.stat(resolved).catch(() => undefined);
      if (!st) {
        diagnostics.push(`${field} 路径不存在: ${entry.source}`);
        items.push({ name: path.basename(entry.source) || entry.source, path: toContainerPathIfInside(settingsSource, resolved) ?? entry.source, source: entry.source, scope: settingsSource.scope, kind, type: "path" });
        continue;
      }
      if (field === "skills") items.push(...await discoverSkillsFromPath(box, resolved, settingsSource.scope, diagnostics));
      if (field === "prompts") items.push(...await discoverPromptsFromPath(box, resolved, settingsSource.scope, diagnostics));
      if (field === "themes") items.push(...await discoverThemesFromPath(box, resolved, settingsSource.scope, diagnostics));
    }
  }
  return items;
}

async function discoverSkillsFromPath(box: BoxRecord, p: string, scope: PiResourceScope, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const st = await fs.stat(p).catch(() => undefined);
  if (!st) return [];
  if (st.isFile() && p.endsWith(".md")) return [await skillItemFromFile(box, p, scope, diagnostics)];
  if (st.isDirectory()) return discoverSkillsFromDir(box, p, scope, true, diagnostics);
  return [];
}

async function discoverSkillsFromDir(box: BoxRecord, dir: string, scope: PiResourceScope, includeRootMd: boolean, diagnostics: string[], depth = 0): Promise<PiLoadedResourceItem[]> {
  if (depth > 6 || !(await fs.pathExists(dir))) return [];
  const items: PiLoadedResourceItem[] = [];
  const skillFile = path.join(dir, "SKILL.md");
  if (await fs.pathExists(skillFile)) return [await skillItemFromFile(box, skillFile, scope, diagnostics)];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(`无法读取 skills 目录 ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && includeRootMd && entry.name.endsWith(".md")) items.push(await skillItemFromFile(box, full, scope, diagnostics));
    else if (entry.isDirectory()) items.push(...await discoverSkillsFromDir(box, full, scope, false, diagnostics, depth + 1));
  }
  return items;
}

async function skillItemFromFile(box: BoxRecord, file: string, scope: PiResourceScope, diagnostics: string[]): Promise<PiLoadedResourceItem> {
  let content = "";
  try { content = await fs.readFile(file, "utf8"); }
  catch (error) { diagnostics.push(`无法读取 skill ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  const fm = parseFrontmatter(content);
  return {
    name: fm.name || path.basename(path.dirname(file)) || path.basename(file, ".md"),
    description: fm.description,
    path: toContainerPath(box, file),
    scope,
    kind: "skill",
    type: path.basename(file) === "SKILL.md" ? "directory" : "file"
  };
}

async function discoverDefaultPrompts(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const roots = [
    { scope: "box" as const, dir: path.join(boxAgentDir(box), "prompts") },
    { scope: "workspace" as const, dir: path.join(workspaceHostPath(box, cwd), ".pi", "prompts") }
  ];
  const items: PiLoadedResourceItem[] = [];
  for (const root of roots) items.push(...await discoverPromptsFromPath(box, root.dir, root.scope, diagnostics));
  return items;
}

async function discoverPromptsFromPath(box: BoxRecord, p: string, scope: PiResourceScope, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const st = await fs.stat(p).catch(() => undefined);
  if (!st) return [];
  const files: string[] = [];
  if (st.isFile() && p.endsWith(".md")) files.push(p);
  if (st.isDirectory()) files.push(...await listFilesByExtension(p, ".md", diagnostics));
  return files.map((file) => ({ name: `/${path.basename(file, ".md")}`, path: toContainerPath(box, file), scope, kind: "prompt" as const, type: "file" }));
}

async function discoverDefaultThemes(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const roots = [
    { scope: "box" as const, dir: path.join(boxAgentDir(box), "themes") },
    { scope: "workspace" as const, dir: path.join(workspaceHostPath(box, cwd), ".pi", "themes") }
  ];
  const items: PiLoadedResourceItem[] = [];
  for (const root of roots) items.push(...await discoverThemesFromPath(box, root.dir, root.scope, diagnostics));
  return items;
}

async function discoverThemesFromPath(box: BoxRecord, p: string, scope: PiResourceScope, diagnostics: string[]): Promise<PiLoadedResourceItem[]> {
  const st = await fs.stat(p).catch(() => undefined);
  if (!st) return [];
  const files: string[] = [];
  if (st.isFile() && p.endsWith(".json")) files.push(p);
  if (st.isDirectory()) files.push(...await listFilesByExtension(p, ".json", diagnostics));
  return files.map((file) => ({ name: path.basename(file, ".json"), path: toContainerPath(box, file), scope, kind: "theme" as const, type: "file" }));
}

async function listFilesByExtension(dir: string, extension: string, diagnostics: string[], depth = 0): Promise<string[]> {
  if (depth > 3 || !(await fs.pathExists(dir))) return [];
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    diagnostics.push(`无法读取目录 ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) files.push(full);
    else if (entry.isDirectory()) files.push(...await listFilesByExtension(full, extension, diagnostics, depth + 1));
  }
  return files;
}

async function loadSettingsSources(box: BoxRecord, cwd: string, diagnostics: string[]): Promise<SettingsSource[]> {
  const cwdHost = workspaceHostPath(box, cwd);
  const sources = [
    { scope: "box" as const, file: path.join(boxAgentDir(box), "settings.json"), baseDir: boxAgentDir(box) },
    { scope: "workspace" as const, file: path.join(cwdHost, ".pi", "settings.json"), baseDir: path.join(cwdHost, ".pi") }
  ];
  const out: SettingsSource[] = [];
  for (const source of sources) {
    const settings = await fs.readJson(source.file).catch((error) => {
      if (error?.code !== "ENOENT") diagnostics.push(`无法读取 settings ${source.file}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }) as unknown;
    if (settings && typeof settings === "object" && !Array.isArray(settings)) out.push({ ...source, settings: settings as Record<string, unknown> });
  }
  return out;
}

function normalizeSourceEntries(value: unknown): SourceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ source: entry.trim() }];
    if (entry && typeof entry === "object" && typeof (entry as any).source === "string" && (entry as any).source.trim()) {
      const objectEntry = entry as Record<string, unknown>;
      const filtered = ["extensions", "skills", "prompts", "themes"].some((field) => Array.isArray(objectEntry[field]));
      return [{ source: (entry as any).source.trim(), filtered }];
    }
    return [];
  });
}

function resolveConfiguredPath(baseDir: string, source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || /^(npm|git|github|https?|ssh):/.test(trimmed)) return undefined;
  if (trimmed.startsWith("~")) return undefined;
  if (trimmed.startsWith("/workspace")) return path.resolve(baseDirForWorkspace(baseDir), trimmed.slice("/workspace".length).replace(/^\/+/, ""));
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.resolve(baseDir, trimmed);
}

function baseDirForWorkspace(baseDir: string): string {
  const marker = `${path.sep}.boxedagent${path.sep}`;
  const idx = baseDir.indexOf(marker);
  if (idx >= 0) return baseDir.slice(0, idx);
  if (baseDir.endsWith(`${path.sep}.boxedagent`)) return path.dirname(baseDir);
  const piIdx = baseDir.indexOf(`${path.sep}.pi${path.sep}`);
  if (piIdx >= 0) return baseDir.slice(0, piIdx);
  if (baseDir.endsWith(`${path.sep}.pi`)) return path.dirname(baseDir);
  return findWorkspaceRootGuess(baseDir);
}

function findWorkspaceRootGuess(baseDir: string): string {
  const resolved = path.resolve(baseDir);
  const parts = resolved.split(path.sep);
  for (const marker of [".boxedagent", ".pi"]) {
    const idx = parts.indexOf(marker);
    if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  }
  const idx = parts.lastIndexOf("workspaces");
  if (idx >= 0 && parts[idx + 1]) return parts.slice(0, idx + 2).join(path.sep) || path.sep;
  return resolved;
}

function toContainerPathIfInside(settingsSource: SettingsSource, hostPath: string): string | undefined {
  const workspaceRoot = baseDirForWorkspace(settingsSource.baseDir);
  const relative = path.relative(workspaceRoot, hostPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return `/workspace/${relative.split(path.sep).join("/")}`.replace(/\/$/, "") || "/workspace";
}

function ancestorDirs(box: BoxRecord, cwdHost: string): string[] {
  const workspaceRoot = path.resolve(box.workspacePath);
  const dirs: string[] = [];
  let current = path.resolve(cwdHost);
  while (true) {
    const relative = path.relative(workspaceRoot, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    dirs.unshift(current);
    if (current === workspaceRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}

async function findEntrypoint(dir: string): Promise<string | undefined> {
  for (const name of ["index.ts", "index.js"]) {
    if (await fs.pathExists(path.join(dir, name))) return name;
  }
  return undefined;
}

function packageDisplayName(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4).replace(/@[^/@]+$/, "") || source;
  if (source.startsWith("git:")) return source.slice(4).split(/[?#]/, 1)[0];
  return source;
}

function dedupeItems(items: PiLoadedResourceItem[]): PiLoadedResourceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.scope}:${item.source ?? item.path}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitItems(items: PiLoadedResourceItem[]): PiLoadedResourceItem[] {
  return items.slice(0, MAX_RESOURCE_ITEMS_PER_SECTION);
}

function boxAgentDir(box: BoxRecord): string {
  return path.join(box.workspacePath, ".boxedagent", "pi-agent");
}

function workspaceHostPath(box: BoxRecord, containerPath: string): string {
  const normalized = normalizeContainerCwd(containerPath);
  const rel = normalized.slice("/workspace".length).replace(/^\/+/, "");
  const base = path.resolve(box.workspacePath);
  return path.resolve(base, rel);
}

function toContainerPath(box: BoxRecord, hostPath: string): string {
  const base = path.resolve(box.workspacePath);
  const resolved = path.resolve(hostPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return resolved;
  const posix = relative.split(path.sep).join("/");
  return posix ? `/workspace/${posix}` : "/workspace";
}

function normalizeContainerCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  const normalized = path.posix.normalize(value.startsWith("/workspace") ? value : path.posix.join("/workspace", value));
  if (normalized === "/workspace" || normalized.startsWith("/workspace/")) return normalized.replace(/\/+$/, "") || "/workspace";
  return "/workspace";
}
