import { SAMPLE_AFURECO_PROJECTS } from "../data/afureco-sample";
import type { AfurecoProject } from "../afureco/types";

const PROJECTS_KEY = "pne.afureco.projects.v1";

function isProject(value: unknown): value is AfurecoProject {
  if (value === null || typeof value !== "object") return false;
  const project = value as Partial<AfurecoProject>;
  return typeof project.projectId === "string"
    && typeof project.projectName === "string"
    && typeof project.workTitle === "string"
    && Array.isArray(project.lines);
}

function readImportedProjects(): AfurecoProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isProject) : [];
  } catch {
    return [];
  }
}

function writeImportedProjects(projects: AfurecoProject[]): void {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export async function listAfurecoProjects(): Promise<AfurecoProject[]> {
  return [...SAMPLE_AFURECO_PROJECTS, ...readImportedProjects()];
}

export async function getAfurecoProject(projectId: string | undefined): Promise<AfurecoProject | undefined> {
  if (!projectId) return undefined;
  return (await listAfurecoProjects()).find((project) => project.projectId === projectId);
}

export async function saveAfurecoProject(project: AfurecoProject): Promise<void> {
  const projects = readImportedProjects().filter((candidate) => candidate.projectId !== project.projectId);
  writeImportedProjects([...projects, project]);
}
