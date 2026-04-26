export const COMPOSER_INSERT_EVENT = "boxedagent:composer-insert";

export interface ComposerInsertDetail {
  sessionId: string;
  text: string;
}

export function insertIntoComposer(sessionId: string, text: string) {
  window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail: { sessionId, text } }));
}

export function workspaceAbsPath(relPath: string) {
  const clean = normalizeRelPath(relPath);
  return clean === "." ? "/workspace" : `/workspace/${clean}`;
}

export function fileRefForWorkspacePath(absPath: string) {
  return /\s/.test(absPath) ? `@"${absPath.replace(/(["\\])/g, "\\$1")}"` : `@${absPath}`;
}

function normalizeRelPath(value: string) {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/") || ".";
}
