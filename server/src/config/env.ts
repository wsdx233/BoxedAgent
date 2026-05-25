import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { z } from "zod";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadDotEnvFile(path.join(rootDir, ".env"));

const BooleanEnv = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default(path.join(rootDir, "data")),
  BOX_IMAGE: z.string().default("boxedagent/ubuntu-dev:24.04"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  BOXEDAGENT_ALLOW_ADVANCED_CONTAINER_OPTIONS: BooleanEnv(true),
  PUBLIC_ORIGIN: z.string().optional(),
  BOXEDAGENT_TOKEN: z.string().optional(),
  AUTH_TOKEN: z.string().optional(),
  SESSION_SECRET: z.string().default("dev-change-me").transform((value) => value || "dev-change-me"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(128),
  WEB_DIST_DIR: z.string().default(path.join(rootDir, "web", "dist")),
  LOG_LEVEL: z.string().default("info")
});

export const env = EnvSchema.parse(process.env);
export const boxedAgentToken = env.BOXEDAGENT_TOKEN?.trim() || env.AUTH_TOKEN?.trim() || "";

const dataDir = resolveFromRoot(env.DATA_DIR);
const webDistDir = resolveFromRoot(env.WEB_DIST_DIR);

export const paths = {
  rootDir,
  dataDir,
  stateFile: path.join(dataDir, "state.json"),
  workspacesDir: path.join(dataDir, "workspaces"),
  uploadsDir: path.join(dataDir, "uploads"),
  imageBuildsDir: path.join(dataDir, "image-builds"),
  webDistDir
};

export async function ensureDataDirs() {
  await fs.ensureDir(paths.dataDir);
  await fs.ensureDir(paths.workspacesDir);
  await fs.ensureDir(paths.uploadsDir);
  await fs.ensureDir(paths.imageBuildsDir);
}

function resolveFromRoot(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function loadDotEnvFile(file: string) {
  if (!fs.pathExistsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(line.slice(idx + 1).trim());
  }
}

function unquoteEnvValue(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner;
  }
  return value;
}
