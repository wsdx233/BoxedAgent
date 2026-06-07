import type { BoxRecord } from "../core/types.js";
import { dockerService } from "../docker/docker-service.js";

const checkedBoxes = new Set<string>();
const pendingChecks = new Map<string, Promise<void>>();

export async function ensureCompatiblePiCli(box: BoxRecord): Promise<void> {
  if (!isDefaultBoxImage(box.image) || checkedBoxes.has(box.id)) return;
  const pending = pendingChecks.get(box.id);
  if (pending) return pending;
  const promise = doEnsureCompatiblePiCli(box).finally(() => pendingChecks.delete(box.id));
  pendingChecks.set(box.id, promise);
  return promise;
}

async function doEnsureCompatiblePiCli(box: BoxRecord): Promise<void> {
  const info = await dockerService.exec(box, ["bash", "-lc", "npm ls -g --depth=0 --json @earendil-works/pi-coding-agent @mariozechner/pi-coding-agent 2>/dev/null || true"], { attachStderr: false });
  const packages = parseGlobalPackages(info.stdout);
  const hasEarendil = Boolean(packages["@earendil-works/pi-coding-agent"]);
  const hasMario = Boolean(packages["@mariozechner/pi-coding-agent"]);
  const result = await dockerService.exec(box, ["bash", "-lc", (!hasEarendil || hasMario) ? upgradeCommand() : ensurePiLinkCommand()], { attachStderr: true });
  if (result.exitCode !== 0) throw new Error(`failed to prepare pi in Box\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`);
  checkedBoxes.add(box.id);
}

function upgradeCommand(): string {
  return [
    "set -e",
    "npm uninstall -g @mariozechner/pi-coding-agent >/dev/null 2>&1 || true",
    "rm -f /usr/local/bin/pi",
    "npm install -g @earendil-works/pi-coding-agent@latest --force --ignore-scripts --no-audit --no-fund",
    ensurePiLinkCommand()
  ].join(" && ");
}

function ensurePiLinkCommand(): string {
  return String.raw`set -e
node_path="$(command -v node || true)"
node_real="$(readlink -f "$node_path" 2>/dev/null || printf '%s' "$node_path")"
node_bin_dir="$(dirname "$node_real")"
npm_prefix="$(npm prefix -g 2>/dev/null || true)"
pi_candidates=""
[ -n "$node_bin_dir" ] && pi_candidates="$pi_candidates $node_bin_dir/pi"
[ -n "$npm_prefix" ] && pi_candidates="$pi_candidates $npm_prefix/bin/pi"
pi_candidates="$pi_candidates /usr/local/bin/pi $(find /opt/nvm -path '*/bin/pi' -type f -perm -111 2>/dev/null | tr '\n' ' ')"
pi_bin=""
for candidate in $pi_candidates; do
  if [ -x "$candidate" ]; then pi_bin="$candidate"; break; fi
done
if [ -z "$pi_bin" ]; then
  echo "Could not locate pi binary" >&2
  echo "node_path=$node_path node_real=$node_real npm_prefix=$npm_prefix" >&2
  echo "candidates=$pi_candidates" >&2
  exit 127
fi
ln -sf "$pi_bin" /usr/local/bin/pi
hash -r
/usr/local/bin/pi --version`;
}

function parseGlobalPackages(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as { dependencies?: Record<string, unknown> };
    return parsed.dependencies ?? {};
  } catch {
    return {};
  }
}

function isDefaultBoxImage(image: string): boolean {
  return image === "boxedagent/ubuntu-dev:24.04" || image.startsWith("boxedagent/ubuntu-dev");
}
