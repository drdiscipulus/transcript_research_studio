import type { CodesProject } from "./api";

export function fileName(path: string | null) {
  if (!path) {
    return "";
  }
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function projectSaveName(project: CodesProject | null) {
  const rawName = project?.name.trim() || "untitled_coding_project";
  const stem = rawName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "");
  return `${stem || "untitled_coding_project"}.evidence.json`;
}

export function projectNameFromPath(path: string) {
  const name = fileName(path).replace(/\.evidence\.json$/i, "").trim();
  return name || "Untitled Coding Project";
}

export function pathDirectory(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return separatorIndex >= 0 ? path.slice(0, separatorIndex) : "";
}
