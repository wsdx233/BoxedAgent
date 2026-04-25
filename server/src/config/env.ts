import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { z } from "zod";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default(path.join(rootDir, "data")),
  BOX_IMAGE: z.string().default("boxedagent/ubuntu-dev:24.04"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  PUBLIC_ORIGIN: z.string().optional(),
  SESSION_SECRET: z.string().default("dev-change-me"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(128),
  WEB_DIST_DIR: z.string().default(path.join(rootDir, "web", "dist")),
  LOG_LEVEL: z.string().default("info")
});

export const env = EnvSchema.parse(process.env);

export const paths = {
  rootDir,
  dataDir: env.DATA_DIR,
  stateFile: path.join(env.DATA_DIR, "state.json"),
  workspacesDir: path.join(env.DATA_DIR, "workspaces"),
  uploadsDir: path.join(env.DATA_DIR, "uploads"),
  webDistDir: env.WEB_DIST_DIR
};

export async function ensureDataDirs() {
  await fs.ensureDir(paths.dataDir);
  await fs.ensureDir(paths.workspacesDir);
  await fs.ensureDir(paths.uploadsDir);
}
