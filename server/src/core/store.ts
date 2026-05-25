import fs from "fs-extra";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env, paths } from "../config/env.js";
import type { AgentSessionRecord, BoxPortMapping, BoxRecord, ContainerBindMount, ContainerDeviceMapping, ContainerGpuConfig, ContainerStartupConfig, ImageBuildConfig, ImageBuildContextFile, ImageProfileRecord, PersistedState, PiBoxConfig } from "./types.js";
import { notFound } from "./errors.js";

const INITIAL_STATE: PersistedState = { version: 2, boxes: [], sessions: [], imageProfiles: [] };

class Mutex {
  private queue = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class Store {
  private state: PersistedState = INITIAL_STATE;
  private mutex = new Mutex();

  async load() {
    const hasState = await fs.pathExists(paths.stateFile);
    const raw = hasState ? await fs.readJson(paths.stateFile) as Partial<PersistedState> & { version?: number } : INITIAL_STATE;
    let shouldPersist = !hasState || raw.version !== 2 || !Array.isArray(raw.imageProfiles);
    const next: PersistedState = {
      version: 2,
      boxes: (raw.boxes ?? []).map((box) => normalizeBox(box as BoxRecord)),
      sessions: (raw.sessions ?? []).map((session) => normalizeSession(session as AgentSessionRecord)),
      imageProfiles: (raw.imageProfiles ?? []).map((profile) => normalizeImageProfile(profile as ImageProfileRecord))
    };
    if (shouldPersist && next.imageProfiles.length === 0) {
      next.imageProfiles = await createDefaultImageProfiles();
    }
    const migratedProfiles = next.imageProfiles.map((profile) => migrateBuiltInImageProfile(profile));
    if (JSON.stringify(migratedProfiles) !== JSON.stringify(next.imageProfiles)) {
      next.imageProfiles = migratedProfiles;
      shouldPersist = true;
    }
    this.state = next;
    if (shouldPersist) await this.persist(next);
  }

  snapshot(): PersistedState {
    return JSON.parse(JSON.stringify(this.state)) as PersistedState;
  }

  listBoxes(): BoxRecord[] {
    return [...this.state.boxes].filter((b) => b.status !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getBox(id: string): BoxRecord {
    const box = this.state.boxes.find((b) => b.id === id && b.status !== "deleted");
    if (!box) throw notFound("box");
    return cloneBox(box);
  }

  async upsertBox(box: BoxRecord): Promise<BoxRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.boxes.findIndex((b) => b.id === box.id);
      const next = normalizeBox({ ...box, updatedAt: new Date().toISOString() });
      if (idx >= 0) this.state.boxes[idx] = next;
      else this.state.boxes.push(next);
      await this.persist(this.state);
      return next;
    });
  }

  async patchBox(id: string, patch: Partial<BoxRecord>): Promise<BoxRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.boxes.findIndex((b) => b.id === id);
      if (idx < 0) throw notFound("box");
      const next = normalizeBox({ ...this.state.boxes[idx], ...patch, updatedAt: new Date().toISOString() });
      this.state.boxes[idx] = next;
      await this.persist(this.state);
      return next;
    });
  }

  listImageProfiles(): ImageProfileRecord[] {
    return [...this.state.imageProfiles]
      .map((profile) => cloneImageProfile(profile))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getImageProfile(id: string): ImageProfileRecord {
    const profile = this.state.imageProfiles.find((item) => item.id === id);
    if (!profile) throw notFound("image profile");
    return cloneImageProfile(profile);
  }

  async upsertImageProfile(profile: ImageProfileRecord): Promise<ImageProfileRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.imageProfiles.findIndex((item) => item.id === profile.id);
      const next = normalizeImageProfile({ ...profile, updatedAt: new Date().toISOString() });
      if (idx >= 0) this.state.imageProfiles[idx] = next;
      else this.state.imageProfiles.push(next);
      await this.persist(this.state);
      return cloneImageProfile(next);
    });
  }

  async patchImageProfile(id: string, patch: Partial<ImageProfileRecord>): Promise<ImageProfileRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.imageProfiles.findIndex((item) => item.id === id);
      if (idx < 0) throw notFound("image profile");
      const next = normalizeImageProfile({ ...this.state.imageProfiles[idx], ...patch, updatedAt: new Date().toISOString() });
      this.state.imageProfiles[idx] = next;
      await this.persist(this.state);
      return cloneImageProfile(next);
    });
  }

  async deleteImageProfile(id: string): Promise<void> {
    return this.mutex.run(async () => {
      const before = this.state.imageProfiles.length;
      this.state.imageProfiles = this.state.imageProfiles.filter((item) => item.id !== id);
      if (before === this.state.imageProfiles.length) throw notFound("image profile");
      await this.persist(this.state);
    });
  }

  listSessions(boxId?: string): AgentSessionRecord[] {
    const activeBoxIds = new Set(this.state.boxes.filter((b) => b.status !== "deleted").map((b) => b.id));
    return [...this.state.sessions]
      .filter((s) => activeBoxIds.has(s.boxId))
      .filter((s) => !boxId || s.boxId === boxId)
      .sort((a, b) => {
        const ar = a.status === "working" || a.status === "running" || a.status === "starting" ? 1 : 0;
        const br = b.status === "working" || b.status === "running" || b.status === "starting" ? 1 : 0;
        if (ar !== br) return br - ar;
        return (b.lastActiveAt ?? b.updatedAt).localeCompare(a.lastActiveAt ?? a.updatedAt);
      });
  }

  getSession(id: string): AgentSessionRecord {
    const session = this.state.sessions.find((s) => s.id === id);
    if (!session) throw notFound("session");
    return { ...session };
  }

  async upsertSession(session: AgentSessionRecord): Promise<AgentSessionRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.sessions.findIndex((s) => s.id === session.id);
      const next = normalizeSession({ ...session, updatedAt: new Date().toISOString() });
      if (idx >= 0) this.state.sessions[idx] = next;
      else this.state.sessions.push(next);
      await this.persist(this.state);
      return next;
    });
  }

  async patchSession(id: string, patch: Partial<AgentSessionRecord>): Promise<AgentSessionRecord> {
    return this.mutex.run(async () => {
      const idx = this.state.sessions.findIndex((s) => s.id === id);
      if (idx < 0) throw notFound("session");
      const next = normalizeSession({ ...this.state.sessions[idx], ...patch, updatedAt: new Date().toISOString() });
      this.state.sessions[idx] = next;
      await this.persist(this.state);
      return next;
    });
  }

  async deleteSession(id: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
      await this.persist(this.state);
    });
  }

  async deleteSessionsForBox(boxId: string): Promise<void> {
    return this.mutex.run(async () => {
      this.state.sessions = this.state.sessions.filter((s) => s.boxId !== boxId);
      await this.persist(this.state);
    });
  }

  async pruneOrphanSessions(): Promise<number> {
    return this.mutex.run(async () => {
      const activeBoxIds = new Set(this.state.boxes.filter((b) => b.status !== "deleted").map((b) => b.id));
      const before = this.state.sessions.length;
      this.state.sessions = this.state.sessions.filter((s) => activeBoxIds.has(s.boxId));
      const removed = before - this.state.sessions.length;
      if (removed > 0) await this.persist(this.state);
      return removed;
    });
  }

  newBoxId() { return `box_${randomUUID()}`; }
  newSessionId() { return `ses_${randomUUID()}`; }
  newImageProfileId() { return `img_${randomUUID()}`; }

  private async persist(state: PersistedState) {
    await fs.ensureDir(paths.dataDir);
    const tmp = `${paths.stateFile}.${process.pid}.tmp`;
    await fs.writeJson(tmp, state, { spaces: 2 });
    await fs.rename(tmp, paths.stateFile);
    this.state = JSON.parse(JSON.stringify(state)) as PersistedState;
  }
}

function normalizePiConfig(pi?: PiBoxConfig): PiBoxConfig {
  return {
    defaultProvider: pi?.defaultProvider,
    defaultModel: pi?.defaultModel,
    defaultThinkingLevel: pi?.defaultThinkingLevel ?? "medium",
    enabledModels: pi?.enabledModels ?? [],
    settingsJson: pi?.settingsJson ?? {},
    modelsJson: pi?.modelsJson ?? {},
    systemPrompt: pi?.systemPrompt ?? "",
    appendSystemPrompt: pi?.appendSystemPrompt ?? "",
    agentsMd: pi?.agentsMd ?? "",
    extraArgs: pi?.extraArgs ?? []
  };
}

function normalizeBox(box: BoxRecord): BoxRecord {
  return {
    ...box,
    env: box.env ?? {},
    labels: box.labels ?? {},
    portMappings: (box.portMappings ?? []).map((mapping) => normalizePortMapping(mapping)),
    pi: normalizePiConfig(box.pi),
    startup: normalizeStartupConfig(box.startup)
  };
}

function normalizePortMapping(mapping: BoxPortMapping): BoxPortMapping {
  const now = new Date().toISOString();
  return {
    id: mapping.id,
    name: mapping.name || `${(mapping.protocol ?? "http").toUpperCase()} ${mapping.port}`,
    port: mapping.port,
    protocol: mapping.protocol === "https" ? "https" : "http",
    slug: mapping.slug,
    openPath: normalizeMappingOpenPath(mapping.openPath),
    createdAt: mapping.createdAt ?? now,
    updatedAt: mapping.updatedAt ?? mapping.createdAt ?? now
  };
}

function normalizeMappingOpenPath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "/") return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeSession(session: AgentSessionRecord): AgentSessionRecord {
  const loadedResources = session.loadedResources && typeof session.loadedResources === "object"
    ? { ...session.loadedResources, cwd: normalizeSessionCwd(session.loadedResources.cwd) }
    : undefined;
  return {
    ...session,
    cwd: normalizeSessionCwd(session.cwd),
    autoCompactionEnabled: session.autoCompactionEnabled ?? true,
    loadedResources
  };
}

function normalizeSessionCwd(cwd?: string): string {
  const value = cwd?.trim() || "/workspace";
  if (value === "/workspace" || value.startsWith("/workspace/")) return value.replace(/\/+$/g, "") || "/workspace";
  return "/workspace";
}

function normalizeImageProfile(profile: ImageProfileRecord): ImageProfileRecord {
  const now = new Date().toISOString();
  return {
    id: profile.id,
    name: profile.name?.trim() || "Untitled image profile",
    description: profile.description ?? "",
    image: profile.image?.trim() || env.BOX_IMAGE,
    baseImage: profile.baseImage?.trim() || undefined,
    dockerfile: profile.dockerfile || `FROM ${env.BOX_IMAGE}\n`,
    build: normalizeBuildConfig(profile.build),
    boxDefaults: normalizeImageProfileBoxDefaults(profile.boxDefaults),
    status: ["draft", "building", "ready", "error"].includes(profile.status) ? profile.status : "draft",
    error: profile.error,
    lastBuiltAt: profile.lastBuiltAt,
    createdAt: profile.createdAt ?? now,
    updatedAt: profile.updatedAt ?? profile.createdAt ?? now
  };
}

function normalizeBuildConfig(build?: ImageBuildConfig): ImageBuildConfig {
  return {
    buildArgs: normalizeStringRecord(build?.buildArgs),
    platform: build?.platform?.trim() || undefined,
    target: build?.target?.trim() || undefined,
    noCache: build?.noCache ?? false,
    pull: build?.pull ?? false,
    contextFiles: (build?.contextFiles ?? []).map((file) => normalizeContextFile(file)).filter(Boolean) as ImageBuildContextFile[]
  };
}

function normalizeContextFile(file: ImageBuildContextFile): ImageBuildContextFile | undefined {
  const filePath = file.path?.trim();
  if (!filePath) return undefined;
  return { path: filePath, content: file.content ?? "", mode: normalizeMode(file.mode) };
}

function normalizeMode(mode?: number): number | undefined {
  if (mode === undefined || !Number.isInteger(mode) || mode < 0 || mode > 0o777) return undefined;
  return mode;
}

function normalizeImageProfileBoxDefaults(boxDefaults: ImageProfileRecord["boxDefaults"] = {}): ImageProfileRecord["boxDefaults"] {
  return {
    env: normalizeStringRecord(boxDefaults.env),
    labels: normalizeStringRecord(boxDefaults.labels),
    memoryMb: normalizePositiveInteger(boxDefaults.memoryMb),
    cpus: normalizePositiveNumber(boxDefaults.cpus),
    enableCodeServer: boxDefaults.enableCodeServer ?? true,
    codeServerPassword: boxDefaults.codeServerPassword ?? "boxedagent",
    pi: normalizePiConfig(boxDefaults.pi as PiBoxConfig | undefined),
    startup: normalizeStartupConfig(boxDefaults.startup)
  };
}

function normalizeStartupConfig(startup?: ContainerStartupConfig): ContainerStartupConfig {
  return {
    workingDir: normalizeAbsoluteContainerPath(startup?.workingDir),
    user: startup?.user?.trim() || undefined,
    startupScript: startup?.startupScript ?? "",
    env: normalizeStringRecord(startup?.env),
    extraHosts: normalizeStringArray(startup?.extraHosts),
    shmSizeMb: normalizePositiveInteger(startup?.shmSizeMb),
    gpu: normalizeGpuConfig(startup?.gpu),
    devices: (startup?.devices ?? []).map((device) => normalizeDeviceMapping(device)).filter(Boolean) as ContainerDeviceMapping[],
    privileged: startup?.privileged || undefined,
    capAdd: normalizeStringArray(startup?.capAdd),
    mounts: (startup?.mounts ?? []).map((mount) => normalizeBindMount(mount)).filter(Boolean) as ContainerBindMount[],
    exposedPorts: normalizePorts(startup?.exposedPorts)
  };
}

function normalizeGpuConfig(gpu?: ContainerGpuConfig): ContainerGpuConfig | undefined {
  if (!gpu?.enabled) return undefined;
  return {
    enabled: true,
    count: gpu.count === "all" ? "all" : normalizePositiveInteger(gpu.count),
    deviceIds: normalizeStringArray(gpu.deviceIds)
  };
}

function normalizeDeviceMapping(device: ContainerDeviceMapping): ContainerDeviceMapping | undefined {
  const pathOnHost = device.pathOnHost?.trim();
  if (!pathOnHost) return undefined;
  return {
    pathOnHost,
    pathInContainer: device.pathInContainer?.trim() || pathOnHost,
    cgroupPermissions: device.cgroupPermissions?.trim() || "rwm"
  };
}

function normalizeBindMount(mount: ContainerBindMount): ContainerBindMount | undefined {
  const source = mount.source?.trim();
  const target = normalizeAbsoluteContainerPath(mount.target);
  if (!source || !target) return undefined;
  return { source, target, readonly: Boolean(mount.readonly) };
}

function normalizeAbsoluteContainerPath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/g, "") || "/" : undefined;
}

function normalizeStringRecord(value?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => key.trim() && typeof item === "string").map(([key, item]) => [key.trim(), item]));
}

function normalizeStringArray(value?: string[]): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function normalizePorts(value?: number[]): number[] {
  return [...new Set((value ?? []).filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
}

function normalizePositiveInteger(value?: number): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizePositiveNumber(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function cloneBox(box: BoxRecord): BoxRecord {
  const normalized = normalizeBox(box);
  return JSON.parse(JSON.stringify(normalized)) as BoxRecord;
}

function cloneImageProfile(profile: ImageProfileRecord): ImageProfileRecord {
  const normalized = normalizeImageProfile(profile);
  return JSON.parse(JSON.stringify(normalized)) as ImageProfileRecord;
}

function migrateBuiltInImageProfile(profile: ImageProfileRecord): ImageProfileRecord {
  if (profile.id !== "profile_cuda_torch") return profile;
  if (profile.dockerfile === cudaTorchDockerfileLegacy()) {
    return normalizeImageProfile({
      ...profile,
      description: "基于默认 Ubuntu Dev，创建 /opt/torch-venv 并安装 PyTorch CUDA wheel；启动配置启用 NVIDIA GPU 和较大的 shm。宿主机需 NVIDIA Container Toolkit。",
      dockerfile: cudaTorchDockerfile()
    });
  }
  return profile;
}

async function createDefaultImageProfiles(): Promise<ImageProfileRecord[]> {
  const now = new Date().toISOString();
  const defaultDockerfile = await fs.readFile(path.join(paths.rootDir, "docker", "box.Dockerfile"), "utf8").catch(() => `FROM ${env.BOX_IMAGE}\n`);
  const commonBoxDefaults: ImageProfileRecord["boxDefaults"] = {
    enableCodeServer: true,
    codeServerPassword: "boxedagent",
    env: {},
    labels: {},
    pi: normalizePiConfig(),
    startup: {}
  };
  return [
    normalizeImageProfile({
      id: "profile_default_ubuntu_dev",
      name: "Ubuntu Dev 24.04",
      description: "BoxedAgent 默认 Ubuntu 24.04 开发镜像。",
      image: env.BOX_IMAGE,
      dockerfile: defaultDockerfile,
      build: {},
      boxDefaults: commonBoxDefaults,
      status: "draft",
      createdAt: now,
      updatedAt: now
    }),
    normalizeImageProfile({
      id: "profile_android_dev",
      name: "Android Dev 24.04",
      description: "基于默认 Ubuntu Dev，预装 OpenJDK、Android command line tools、platform-tools、Android 35 构建工具；启动配置包含 /dev/kvm 和较大的 shm。",
      image: "boxedagent/android-dev:24.04",
      baseImage: env.BOX_IMAGE,
      dockerfile: androidDockerfile(),
      build: { buildArgs: { BASE_IMAGE: env.BOX_IMAGE } },
      boxDefaults: {
        ...commonBoxDefaults,
        memoryMb: 8192,
        cpus: 4,
        startup: {
          shmSizeMb: 2048,
          devices: [{ pathOnHost: "/dev/kvm", pathInContainer: "/dev/kvm", cgroupPermissions: "rwm" }]
        },
        pi: { ...normalizePiConfig(), appendSystemPrompt: "这是一个 Android 开发 Box，优先使用 Gradle/Android SDK 命令完成构建、测试和诊断。" }
      },
      status: "draft",
      createdAt: now,
      updatedAt: now
    }),
    normalizeImageProfile({
      id: "profile_cuda_torch",
      name: "CUDA Torch 24.04",
      description: "基于默认 Ubuntu Dev，创建 /opt/torch-venv 并安装 PyTorch CUDA wheel；启动配置启用 NVIDIA GPU 和较大的 shm。宿主机需 NVIDIA Container Toolkit。",
      image: "boxedagent/cuda-torch:24.04",
      baseImage: env.BOX_IMAGE,
      dockerfile: cudaTorchDockerfile(),
      build: { buildArgs: { BASE_IMAGE: env.BOX_IMAGE } },
      boxDefaults: {
        ...commonBoxDefaults,
        memoryMb: 16384,
        cpus: 8,
        env: {
          NVIDIA_VISIBLE_DEVICES: "all",
          NVIDIA_DRIVER_CAPABILITIES: "compute,utility"
        },
        startup: {
          shmSizeMb: 8192,
          gpu: { enabled: true, count: "all" }
        },
        pi: { ...normalizePiConfig(), appendSystemPrompt: "这是一个 CUDA / PyTorch 开发 Box；需要验证 GPU 时优先运行 nvidia-smi 和简短 torch.cuda 检查。" }
      },
      status: "draft",
      createdAt: now,
      updatedAt: now
    })
  ];
}

function androidDockerfile(): string {
  return `ARG BASE_IMAGE=${env.BOX_IMAGE}
FROM \${BASE_IMAGE}

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="\${PATH}:\${ANDROID_HOME}/cmdline-tools/latest/bin:\${ANDROID_HOME}/platform-tools"

RUN apt-get update \\
  && apt-get install -y --no-install-recommends openjdk-17-jdk unzip zip \\
  && mkdir -p \${ANDROID_HOME}/cmdline-tools \\
  && cd /tmp \\
  && curl -fsSL -o commandlinetools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \\
  && unzip commandlinetools.zip -d \${ANDROID_HOME}/cmdline-tools \\
  && mv \${ANDROID_HOME}/cmdline-tools/cmdline-tools \${ANDROID_HOME}/cmdline-tools/latest \\
  && yes | sdkmanager --licenses \\
  && sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \\
  && rm -rf /var/lib/apt/lists/* /tmp/commandlinetools.zip
`;
}

function cudaTorchDockerfile(): string {
  return `ARG BASE_IMAGE=${env.BOX_IMAGE}
FROM \${BASE_IMAGE}

ENV TORCH_VENV=/opt/torch-venv
ENV PATH="\${TORCH_VENV}/bin:\${PATH}"

RUN python3 -m venv \${TORCH_VENV} \\
  && \${TORCH_VENV}/bin/python -m pip install --upgrade pip \\
  && \${TORCH_VENV}/bin/pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124 \\
  && \${TORCH_VENV}/bin/python - <<'PY'
import torch
print('torch', torch.__version__)
print('cuda available', torch.cuda.is_available())
PY
`;
}

function cudaTorchDockerfileLegacy(): string {
  return `ARG BASE_IMAGE=${env.BOX_IMAGE}
FROM \${BASE_IMAGE}

RUN python3 -m pip install --upgrade pip \\
  && python3 -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
`;
}

export const store = new Store();
