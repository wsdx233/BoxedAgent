import Docker from "dockerode";
import fs from "fs-extra";
import { createReadStream } from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import tar from "tar-stream";
import { env, paths } from "../config/env.js";
import type { BoxRecord, BoxSpec, ContainerBindMount, ContainerStartupConfig, ImageBuildContextFile, ImageProfileRecord } from "../core/types.js";
import { badRequest, conflict, notFound } from "../core/errors.js";
import { materializeBoxPiConfig, piRuntimeEnv } from "../agent/pi-config.js";
import { wsHub } from "../ws/hub.js";

const DEFAULT_BOX_REVISION_LABEL = "boxedagent.default-box-revision";
const DEFAULT_BOX_REVISION = "2026-06-07-pi-earendil-latest";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
}

export interface ImageStatus {
  image: string;
  available: boolean;
  source: "local" | "built" | "pulled" | "missing";
  error?: string;
}

export class DockerService {
  readonly docker: Docker;
  private imageEnsures = new Map<string, Promise<ImageStatus>>();

  constructor() {
    this.docker = new Docker({ socketPath: env.DOCKER_SOCKET });
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async imageStatus(image: string): Promise<ImageStatus> {
    try {
      await this.docker.getImage(image).inspect();
      return { image, available: true, source: "local" };
    } catch (error) {
      if (this.isNotFound(error)) return { image, available: false, source: "missing" };
      return { image, available: false, source: "missing", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureImage(image: string): Promise<ImageStatus> {
    const existing = await this.imageStatus(image);
    if (existing.available && (!this.isDefaultBoxImage(image) || await this.defaultBoxImageIsCurrent(image))) return existing;

    const pending = this.imageEnsures.get(image);
    if (pending) return pending;

    const promise = (async () => {
      const action = this.isDefaultBoxImage(image) ? "build" : "pull";
      wsHub.publishGlobal({ type: "image_ensure_start", image, action });
      try {
        if (this.isDefaultBoxImage(image)) {
          await this.buildDefaultImage(image);
          wsHub.publishGlobal({ type: "image_ensure_end", image, action, source: "built" });
          return { image, available: true, source: "built" as const };
        }
        await this.pullImage(image);
        wsHub.publishGlobal({ type: "image_ensure_end", image, action, source: "pulled" });
        return { image, available: true, source: "pulled" as const };
      } catch (error) {
        wsHub.publishGlobal({ type: "image_ensure_error", image, action, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    })().finally(() => this.imageEnsures.delete(image));

    this.imageEnsures.set(image, promise);
    return promise;
  }

  async buildImageProfile(profile: ImageProfileRecord): Promise<ImageStatus> {
    const image = profile.image.trim();
    if (!image) throw badRequest("image tag is required");
    const action = "build";
    wsHub.publishGlobal({ type: "image_profile_build_start", profileId: profile.id, image, action });
    if (profile.baseImage) await this.ensureImage(profile.baseImage);

    const buildDir = path.join(paths.imageBuildsDir, profile.id.replace(/[^a-zA-Z0-9_.-]/g, "-"), String(Date.now()));
    const contextRoot = path.resolve(buildDir);
    try {
      await fs.emptyDir(contextRoot);
      await fs.writeFile(path.join(contextRoot, "Dockerfile"), profile.dockerfile || `FROM ${profile.baseImage || env.BOX_IMAGE}\n`, "utf8");
      for (const file of profile.build.contextFiles ?? []) await this.writeBuildContextFile(contextRoot, file);
      const src = await listBuildContextFiles(contextRoot);
      const stream = await this.docker.buildImage({ context: contextRoot, src }, {
        t: image,
        dockerfile: "Dockerfile",
        buildargs: profile.build.buildArgs,
        platform: profile.build.platform,
        target: profile.build.target,
        nocache: profile.build.noCache,
        pull: profile.build.pull
      });
      await this.followProgress(stream as unknown as NodeJS.ReadableStream, (message, raw) => wsHub.publishGlobal({ type: "image_profile_progress", profileId: profile.id, image, message, raw }));
      await this.assertImageAvailable(image, "Docker build finished but the tagged image was not created");
      wsHub.publishGlobal({ type: "image_profile_build_end", profileId: profile.id, image, action, source: "built" });
      return { image, available: true, source: "built" };
    } catch (error) {
      wsHub.publishGlobal({ type: "image_profile_build_error", profileId: profile.id, image, action, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      await fs.remove(contextRoot).catch(() => undefined);
    }
  }

  async createContainer(box: BoxRecord): Promise<string> {
    await materializeBoxPiConfig(box);
    await this.ensureImage(box.image);
    await fs.ensureDir(box.workspacePath);
    assertAdvancedOptionsAllowed(box.startup);
    const name = this.containerName(box.id);
    const envVars = this.containerEnv(box);
    const exposedPorts = this.containerExposedPorts(box);

    const container = await this.docker.createContainer({
      Image: box.image,
      name,
      WorkingDir: box.startup?.workingDir || "/workspace",
      User: box.startup?.user,
      Tty: false,
      OpenStdin: false,
      Env: envVars,
      Labels: {
        "boxedagent.managed": "true",
        "boxedagent.boxId": box.id,
        ...box.labels
      },
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      HostConfig: this.containerHostConfig(box),
      Cmd: ["bash", "-lc", this.containerEntrypointScript(box)]
    });
    return container.id;
  }

  async start(box: BoxRecord): Promise<{ containerId: string; state: string }> {
    const container = await this.ensureContainer(box);
    const info = await container.inspect();
    if (!info.State.Running) await container.start();
    const next = await container.inspect();
    return { containerId: next.Id, state: next.State.Status };
  }

  async stop(box: BoxRecord, timeout = 10): Promise<void> {
    const container = await this.findContainer(box);
    if (!container) return;
    const info = await container.inspect();
    if (info.State.Running) await container.stop({ t: timeout });
  }

  async remove(box: BoxRecord, force = false): Promise<void> {
    const container = await this.findContainer(box);
    if (!container) return;
    await container.remove({ force });
  }

  async cloneContainerToImage(source: BoxRecord, targetImage: string): Promise<boolean> {
    const container = await this.findContainer(source);
    if (!container) return false;
    await container.commit({ repo: targetImage.split(":")[0], tag: targetImage.split(":")[1] ?? "latest" });
    return true;
  }

  async inspect(box: BoxRecord) {
    const container = await this.ensureContainer(box);
    return container.inspect();
  }

  async codeServerTarget(box: BoxRecord): Promise<string> {
    if (!box.enableCodeServer) throw badRequest("code-server is disabled for this box");
    await this.start(box);
    return this.boxPortTarget(box, 8081, "http", "code-server port is not available yet");
  }

  async boxPortTarget(box: BoxRecord, port: number, protocol: "http" | "https", unavailableMessage = "box port is not available yet"): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest("invalid port");
    const info = await this.inspect(box);
    const binding = info.NetworkSettings.Ports?.[`${port}/tcp`]?.[0];
    if (binding?.HostPort) return `${protocol}://127.0.0.1:${binding.HostPort}`;
    const networks = Object.values((info.NetworkSettings as any).Networks ?? {}) as Array<{ IPAddress?: string }>;
    const ip = networks.find((network) => network.IPAddress)?.IPAddress || info.NetworkSettings.IPAddress;
    if (ip) return `${protocol}://${ip}:${port}`;
    throw conflict(unavailableMessage);
  }

  async exec(box: BoxRecord, cmd: string[], opts?: { cwd?: string; env?: string[]; tty?: boolean; attachStderr?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const container = await this.ensureRunningContainer(box);
    const exec = await container.exec({
      Cmd: cmd,
      WorkingDir: opts?.cwd ?? "/workspace",
      Env: opts?.env,
      AttachStdout: true,
      AttachStderr: opts?.attachStderr ?? true,
      Tty: opts?.tty ?? false
    });
    const stream = await exec.start({ hijack: false, stdin: false });
    let stdout = "";
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const out = new PassThrough();
      const err = new PassThrough();
      out.on("data", (d) => (stdout += d.toString("utf8")));
      err.on("data", (d) => (stderr += d.toString("utf8")));
      stream.on("error", reject);
      stream.on("end", resolve);
      this.docker.modem.demuxStream(stream, out, err);
    });
    const inspect = await exec.inspect();
    return { stdout, stderr, exitCode: inspect.ExitCode ?? 0 };
  }

  async createInteractiveExec(box: BoxRecord, cmd: string[], opts?: { cwd?: string; env?: string[]; tty?: boolean }) {
    const container = await this.ensureRunningContainer(box);
    return container.exec({ Cmd: cmd, WorkingDir: opts?.cwd ?? "/workspace", Env: opts?.env, AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: opts?.tty ?? true });
  }

  async listFiles(box: BoxRecord, rel = "."): Promise<FileEntry[]> {
    const script = `
import json, os, sys, stat
root='/workspace'
rel=sys.argv[1]
target=os.path.abspath(os.path.join(root, rel))
if not (target == root or target.startswith(root + os.sep)):
    raise SystemExit('path escapes workspace')
if not os.path.exists(target):
    raise SystemExit('directory does not exist: ' + target)
if not os.path.isdir(target):
    raise SystemExit('not a directory: ' + target)
items=[]
for name in sorted(os.listdir(target), key=lambda s: (not os.path.isdir(os.path.join(target,s)), s.lower())):
    p=os.path.join(target,name)
    st=os.lstat(p)
    mode=st.st_mode
    if stat.S_ISDIR(mode): typ='directory'
    elif stat.S_ISREG(mode): typ='file'
    elif stat.S_ISLNK(mode): typ='symlink'
    else: typ='other'
    rp=os.path.relpath(p, root)
    items.append({'name':name,'path':rp,'type':typ,'size':st.st_size,'modifiedAt':str(int(st.st_mtime*1000))})
print(json.dumps(items))`;
    const result = await this.exec(box, ["python3", "-c", script, rel]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "failed to list files");
    return JSON.parse(result.stdout) as FileEntry[];
  }

  async readArchiveFile(box: BoxRecord, relPath: string, rangeHeader?: string): Promise<{ stream: Readable; filename: string; size: number; contentLength: number; contentRange?: string; statusCode: number }> {
    const hostPath = await this.toWorkspaceHostPath(box, relPath);
    const stat = await fs.stat(hostPath).catch((error) => {
      if ((error as any)?.code === "ENOENT") throw notFound("file not found");
      throw error;
    });
    if (!stat.isFile()) throw badRequest("not a regular file");

    const size = stat.size;
    const range = parseByteRange(rangeHeader, size);
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, size - 1);
    const stream = size === 0 ? Readable.from([]) : createReadStream(hostPath, { start, end });
    const contentLength = size === 0 ? 0 : end - start + 1;
    return {
      stream,
      filename: path.basename(hostPath),
      size,
      contentLength,
      contentRange: range ? `bytes ${start}-${end}/${size}` : undefined,
      statusCode: range ? 206 : 200
    };
  }

  async putFile(box: BoxRecord, relDir: string, filename: string, content: Buffer): Promise<void> {
    const container = await this.ensureRunningContainer(box);
    if (filename.includes("/") || filename.includes("\\")) throw badRequest("invalid filename");
    const targetDir = this.toContainerPath(relDir);
    await this.mkdir(box, relDir);
    const pack = tar.pack();
    pack.entry({ name: filename, size: content.length, mode: 0o644 }, content);
    pack.finalize();
    await container.putArchive(pack, { path: targetDir });
  }

  async mkdir(box: BoxRecord, relPath: string): Promise<void> {
    const result = await this.exec(box, ["python3", "-c", "import os,sys; root='/workspace'; p=os.path.abspath(os.path.join(root, sys.argv[1])); assert p==root or p.startswith(root+os.sep); os.makedirs(p, exist_ok=True)", relPath]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "mkdir failed");
  }

  async directoryExists(box: BoxRecord, relPath: string): Promise<boolean> {
    const script = "import os,sys; root='/workspace'; p=os.path.abspath(os.path.join(root, sys.argv[1])); assert p==root or p.startswith(root+os.sep); print('1' if os.path.isdir(p) else '0')";
    const result = await this.exec(box, ["python3", "-c", script, relPath]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "failed to check directory");
    return result.stdout.trim() === "1";
  }

  async assertDirectory(box: BoxRecord, relPath: string): Promise<void> {
    if (!(await this.directoryExists(box, relPath))) throw badRequest(`directory does not exist: /workspace/${relPath === "." ? "" : relPath}`.replace(/\/$/, ""));
  }

  async copyPath(box: BoxRecord, sourceRelPath: string, targetRelPath: string): Promise<void> {
    const script = `
import os, sys, shutil
root = '/workspace'
def resolve(rel):
    p = os.path.abspath(os.path.join(root, rel))
    if not (p == root or p.startswith(root + os.sep)):
        raise SystemExit('path escapes workspace')
    return p
src = resolve(sys.argv[1])
dst = resolve(sys.argv[2])
if src == root:
    raise SystemExit('cannot copy workspace root')
if not os.path.lexists(src):
    raise SystemExit('source does not exist')
if os.path.lexists(dst):
    raise SystemExit('target already exists')
if os.path.isdir(src) and not os.path.islink(src) and (dst == src or dst.startswith(src + os.sep)):
    raise SystemExit('cannot copy directory into itself')
os.makedirs(os.path.dirname(dst), exist_ok=True)
if os.path.isdir(src) and not os.path.islink(src):
    shutil.copytree(src, dst, symlinks=True)
else:
    shutil.copy2(src, dst, follow_symlinks=False)
`;
    const result = await this.exec(box, ["python3", "-c", script, sourceRelPath, targetRelPath]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "copy failed");
  }

  async movePath(box: BoxRecord, sourceRelPath: string, targetRelPath: string): Promise<void> {
    const script = `
import os, sys, shutil
root = '/workspace'
def resolve(rel):
    p = os.path.abspath(os.path.join(root, rel))
    if not (p == root or p.startswith(root + os.sep)):
        raise SystemExit('path escapes workspace')
    return p
src = resolve(sys.argv[1])
dst = resolve(sys.argv[2])
if src == root:
    raise SystemExit('cannot move workspace root')
if not os.path.lexists(src):
    raise SystemExit('source does not exist')
if os.path.lexists(dst):
    raise SystemExit('target already exists')
if os.path.isdir(src) and not os.path.islink(src) and (dst == src or dst.startswith(src + os.sep)):
    raise SystemExit('cannot move directory into itself')
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.move(src, dst)
`;
    const result = await this.exec(box, ["python3", "-c", script, sourceRelPath, targetRelPath]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "move failed");
  }

  async deletePath(box: BoxRecord, relPath: string): Promise<void> {
    const result = await this.exec(box, ["python3", "-c", "import os,sys,shutil; root='/workspace'; p=os.path.abspath(os.path.join(root, sys.argv[1])); assert p!=root and p.startswith(root+os.sep); shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else os.remove(p)", relPath]);
    if (result.exitCode !== 0) throw badRequest(result.stderr || result.stdout || "delete failed");
  }

  async findContainer(box: BoxRecord): Promise<Docker.Container | undefined> {
    if (box.containerId) {
      const byId = this.docker.getContainer(box.containerId);
      try {
        await byId.inspect();
        return byId;
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
      }
    }

    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [`boxedagent.boxId=${box.id}`]
      } as any
    });
    const byLabel = containers[0];
    if (byLabel) return this.docker.getContainer(byLabel.Id);

    const byName = await this.docker.listContainers({ all: true, filters: { name: [this.containerName(box.id)] } as any });
    if (byName[0]) return this.docker.getContainer(byName[0].Id);
    return undefined;
  }

  async ensureContainer(box: BoxRecord): Promise<Docker.Container> {
    await materializeBoxPiConfig(box);
    const existing = await this.findContainer(box);
    if (existing) return existing;
    const id = await this.createContainer(box);
    return this.docker.getContainer(id);
  }

  async ensureRunningContainer(box: BoxRecord): Promise<Docker.Container> {
    const container = await this.ensureContainer(box);
    const info = await container.inspect();
    if (!info.State.Running) await container.start();
    return container;
  }

  private containerEnv(box: BoxRecord): string[] {
    return Object.entries({
      ...(box.env ?? {}),
      ...(box.startup?.env ?? {}),
      ...Object.fromEntries(piRuntimeEnv(box, { stdioGuard: false }).map((entry) => {
        const idx = entry.indexOf("=");
        return [entry.slice(0, idx), entry.slice(idx + 1)];
      })),
      BOXEDAGENT_BOX_ID: box.id,
      BOXEDAGENT_BOX_NAME: box.name,
      BOXEDAGENT_CODE_SERVER: box.enableCodeServer ? "1" : "0",
      PASSWORD: box.codeServerPassword ?? "boxedagent"
    }).map(([k, v]) => `${k}=${v}`);
  }

  private containerExposedPorts(box: BoxRecord): Record<string, Record<string, never>> {
    const ports = new Set<number>(box.startup?.exposedPorts ?? []);
    if (box.enableCodeServer) ports.add(8081);
    return Object.fromEntries([...ports].filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535).map((port) => [`${port}/tcp`, {}]));
  }

  private containerHostConfig(box: BoxRecord): Docker.HostConfig {
    const startup = box.startup ?? {};
    const portBindings = box.enableCodeServer ? { "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } : undefined;
    const binds = [`${box.workspacePath}:/workspace`, ...this.startupMountBinds(startup.mounts ?? [])];
    const hostConfig: Docker.HostConfig = {
      Binds: binds,
      AutoRemove: false,
      Memory: box.memoryMb ? box.memoryMb * 1024 * 1024 : undefined,
      NanoCpus: box.cpus ? Math.floor(box.cpus * 1_000_000_000) : undefined,
      PortBindings: portBindings,
      SecurityOpt: ["no-new-privileges:false"],
      ExtraHosts: ["host.docker.internal:host-gateway", ...(startup.extraHosts ?? [])],
      ShmSize: startup.shmSizeMb ? startup.shmSizeMb * 1024 * 1024 : undefined,
      Privileged: startup.privileged,
      CapAdd: startup.capAdd?.length ? startup.capAdd : undefined,
      Devices: startup.devices?.length ? startup.devices.map((device) => ({
        PathOnHost: device.pathOnHost,
        PathInContainer: device.pathInContainer || device.pathOnHost,
        CgroupPermissions: device.cgroupPermissions || "rwm"
      })) : undefined
    };
    if (startup.gpu?.enabled) {
      const deviceRequest: Docker.DeviceRequest = { Driver: "nvidia", Capabilities: [["gpu"]] };
      if (startup.gpu.deviceIds?.length) deviceRequest.DeviceIDs = startup.gpu.deviceIds;
      else if (startup.gpu.count === "all" || startup.gpu.count === undefined) deviceRequest.Count = -1;
      else deviceRequest.Count = startup.gpu.count;
      hostConfig.DeviceRequests = [deviceRequest];
    }
    return hostConfig;
  }

  private startupMountBinds(mounts: ContainerBindMount[]): string[] {
    return mounts
      .filter((mount) => mount.source && mount.target && mount.target !== "/workspace" && !mount.target.startsWith("/workspace/"))
      .map((mount) => `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  }

  private containerEntrypointScript(box: BoxRecord): string {
    const userScript = box.startup?.startupScript?.trim();
    return [
      "set -e",
      "mkdir -p /workspace ~/.local/share/code-server",
      "if [ \"$BOXEDAGENT_CODE_SERVER\" = \"1\" ] && command -v code-server >/dev/null 2>&1; then code-server /workspace --bind-addr 0.0.0.0:8081 --auth password --disable-telemetry >/tmp/code-server.log 2>&1 & fi",
      userScript ? `# BoxedAgent image profile startup script\n${userScript}` : "",
      "sleep infinity"
    ].filter(Boolean).join("\n");
  }

  private async writeBuildContextFile(root: string, file: ImageBuildContextFile): Promise<void> {
    const target = safeBuildContextPath(root, file.path);
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, file.content ?? "", "utf8");
    if (file.mode) await fs.chmod(target, file.mode);
  }

  private async buildDefaultImage(image: string): Promise<void> {
    const context = path.join(paths.rootDir, "docker");
    const dockerfile = path.join(context, "box.Dockerfile");
    if (!(await fs.pathExists(dockerfile))) throw notFound(`default box Dockerfile (${dockerfile})`);
    const stream = await this.docker.buildImage({ context, src: ["box.Dockerfile"] }, { t: image, dockerfile: "box.Dockerfile" });
    await this.followProgress(stream as unknown as NodeJS.ReadableStream);
    await this.assertImageAvailable(image, "Docker build finished but the tagged image was not created");
  }

  private async defaultBoxImageIsCurrent(image: string): Promise<boolean> {
    try {
      const info = await this.docker.getImage(image).inspect();
      return info.Config?.Labels?.[DEFAULT_BOX_REVISION_LABEL] === DEFAULT_BOX_REVISION;
    } catch {
      return false;
    }
  }

  private async pullImage(image: string): Promise<void> {
    const stream = await this.docker.pull(image);
    await this.followProgress(stream as unknown as NodeJS.ReadableStream);
    await this.assertImageAvailable(image, "Docker pull finished but the image is still unavailable");
  }

  private followProgress(stream: NodeJS.ReadableStream, onProgress?: (message: string, raw: unknown) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let streamError: Error | undefined;
      const tail: string[] = [];
      this.docker.modem.followProgress(stream, (error: Error | null, result: unknown) => {
        if (error) reject(error);
        else if (streamError) reject(streamError);
        else resolve(result);
      }, (event: any) => {
        const text = event?.stream || event?.status || event?.error || event?.errorDetail?.message || event?.aux?.ID;
        if (text) {
          const line = String(text).trim();
          if (line) {
            tail.push(line);
            if (tail.length > 30) tail.shift();
            if (onProgress) onProgress(line, event);
            else wsHub.publishGlobal({ type: "image_progress", message: line, raw: event });
          }
        }
        if (event?.error || event?.errorDetail) {
          const detail = event?.errorDetail?.message || event?.error;
          streamError = new Error(`${detail}\n${tail.join("\n")}`);
        }
      });
    });
  }

  private async assertImageAvailable(image: string, message: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch (error) {
      throw new Error(`${message}: ${image}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isDefaultBoxImage(image: string): boolean {
    return image === env.BOX_IMAGE || image.startsWith("boxedagent/ubuntu-dev");
  }

  private isNotFound(error: unknown): boolean {
    const err = error as any;
    return err?.statusCode === 404 || /no such (image|container)|not found/i.test(String(err?.message ?? err));
  }

  private containerName(id: string) {
    return `boxedagent-${id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  }

  private async toWorkspaceHostPath(box: BoxRecord, rel: string): Promise<string> {
    const normalized = path.posix.normalize(`/${rel}`).replace(/^\/+/, "");
    if (normalized.startsWith("..")) throw badRequest("path escapes workspace");
    const base = path.resolve(box.workspacePath);
    const target = path.resolve(base, normalized);
    const relative = path.relative(base, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw badRequest("path escapes workspace");

    let baseReal: string;
    let targetReal: string;
    try {
      [baseReal, targetReal] = await Promise.all([fs.realpath(base), fs.realpath(target)]);
    } catch (error) {
      if ((error as any)?.code === "ENOENT") throw notFound("file not found");
      throw error;
    }
    const realRelative = path.relative(baseReal, targetReal);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw badRequest("path escapes workspace");
    return targetReal;
  }

  private toContainerPath(rel: string): string {
    const normalized = path.posix.normalize(`/${rel}`).replace(/^\/+/, "");
    if (normalized.startsWith("..")) throw badRequest("path escapes workspace");
    return path.posix.join("/workspace", normalized);
  }
}

function parseByteRange(rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!rangeHeader || size <= 0) return undefined;
  const match = /^bytes=([^,]+)$/i.exec(rangeHeader.trim());
  if (!match) return undefined;
  const [startText = "", endText = ""] = match[1].split("-", 2);
  let start: number;
  let end: number;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
    end = Math.min(end, size - 1);
  }

  if (start < 0 || end < start || start >= size) throw badRequest("requested range not satisfiable");
  return { start, end };
}

function assertAdvancedOptionsAllowed(startup?: ContainerStartupConfig): void {
  if (env.BOXEDAGENT_ALLOW_ADVANCED_CONTAINER_OPTIONS) return;
  const hasAdvanced = Boolean(
    startup?.privileged ||
    startup?.capAdd?.length ||
    startup?.devices?.length ||
    startup?.mounts?.length ||
    startup?.gpu?.enabled ||
    startup?.extraHosts?.length ||
    startup?.shmSizeMb ||
    startup?.user
  );
  if (hasAdvanced) throw badRequest("advanced container options are disabled by BOXEDAGENT_ALLOW_ADVANCED_CONTAINER_OPTIONS=0");
}

function safeBuildContextPath(root: string, relPath: string): string {
  const normalized = path.posix.normalize(`/${relPath}`).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) throw badRequest("invalid build context file path");
  const base = path.resolve(root);
  const target = path.resolve(base, normalized);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw badRequest("build context file path escapes context");
  return target;
}

async function listBuildContextFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(root);
  return out;
}

export const dockerService = new DockerService();

export function defaultBoxSpec(partial: Partial<BoxSpec> & { name: string }): BoxSpec {
  return {
    name: partial.name,
    description: partial.description ?? "",
    image: partial.image ?? env.BOX_IMAGE,
    imageProfileId: partial.imageProfileId,
    workspacePath: partial.workspacePath ?? path.join(paths.workspacesDir, partial.name.replace(/[^a-zA-Z0-9_.-]/g, "-")),
    env: partial.env ?? {},
    labels: partial.labels ?? {},
    memoryMb: partial.memoryMb,
    cpus: partial.cpus,
    enableCodeServer: partial.enableCodeServer ?? true,
    codeServerPassword: partial.codeServerPassword ?? "boxedagent",
    portMappings: partial.portMappings ?? [],
    pi: partial.pi ?? { defaultThinkingLevel: "medium", enabledModels: [], settingsJson: {}, modelsJson: {}, systemPrompt: "", appendSystemPrompt: "", agentsMd: "", extraArgs: [] },
    startup: partial.startup ?? {}
  };
}
