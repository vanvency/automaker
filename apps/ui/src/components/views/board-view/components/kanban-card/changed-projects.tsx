import { memo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ChangedProject } from '@automaker/types';
import type { Feature } from '@/store/app-store';

interface RawChangedProject {
  name?: unknown;
  mrUrl?: unknown;
  url?: unknown;
}

const MR_URL_PATTERN = /^https?:\/\/\S+\/merge_requests\/\d+\/?$/i;
const PROJECT_MR_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:\*\*)?([^:*\n]{1,120}?)(?:\*\*)?\s*[:：]\s*(https?:\/\/\S+\/merge_requests\/\d+\/?)\s*$/i;

/**
 * Resolve `group/subgroup/project` from a GitLab merge request URL.
 */
export function deriveProjectNameFromMrUrl(mrUrl: string | undefined): string | undefined {
  if (!mrUrl) return undefined;
  const match = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?merge_requests\/\d+\/?$/i.exec(mrUrl.trim());
  const projectPath = match?.[1]?.trim();
  return projectPath ? projectPath : undefined;
}

/**
 * The linked repository is authoritative, regardless of receipt/summary aliases.
 */
function applyRealProjectNames(projects: ChangedProject[]): ChangedProject[] {
  return projects.map((project) => {
    if (!project.mrUrl) return project;
    const derived = deriveProjectNameFromMrUrl(project.mrUrl);
    return derived ? { ...project, name: derived } : project;
  });
}

/**
 * Cards show only the repository name, not the GitLab group path.
 *
 * Receipts may store `llm/llmops/product/vibe-llmops (root, AIP-114866 gitlink)`
 * or `saas/saas-frontend`; both should read as `vibe-llmops` / `saas-frontend` on a
 * card. Any trailing annotation in parentheses is dropped as well.
 */
export function shortenProjectName(name: string): string {
  const withoutAnnotation = name.split('(')[0]?.trim() ?? name;
  const segments = withoutAnnotation.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? withoutAnnotation;
}

function normalizeProjectName(value: unknown): string {
  return String(value ?? '')
    .replace(/^\s*(?:[-*]\s*)?(?:\*\*)?/, '')
    .replace(/(?:\*\*)?\s*$/, '')
    .replace(/^`|`$/g, '')
    .trim();
}

function normalizeMrUrl(value: unknown): string | undefined {
  const url = String(value ?? '').trim();
  return MR_URL_PATTERN.test(url) ? url : undefined;
}

function projectMatchesUrl(projectName: string, mrUrl: string): boolean {
  const projectLeaf = shortenProjectName(projectName).toLowerCase();
  if (!projectLeaf) return false;

  const url = mrUrl.toLowerCase();
  return (
    url.includes(`/${projectLeaf}/`) ||
    url.includes(`/${projectLeaf}/-/merge_requests/`) ||
    url.endsWith(`/${projectLeaf}`)
  );
}

function normalizeMergeRequests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry): string | undefined => {
      if (typeof entry === 'string') return normalizeMrUrl(entry);
      if (entry && typeof entry === 'object') {
        const record = entry as { url?: unknown; mrUrl?: unknown };
        return normalizeMrUrl(record.url ?? record.mrUrl);
      }
      return undefined;
    })
    .filter((url): url is string => Boolean(url));
}

function normalizeChangedProjects(value: unknown): ChangedProject[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry): ChangedProject | null => {
      if (typeof entry === 'string') {
        const name = normalizeProjectName(entry);
        return name ? { name } : null;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as RawChangedProject;
        const name = normalizeProjectName(record.name);
        if (!name) return null;
        return {
          name,
          mrUrl: normalizeMrUrl(record.mrUrl ?? record.url),
        };
      }
      return null;
    })
    .filter((project): project is ChangedProject => Boolean(project));
}

function parseSummaryProjects(summary: string | undefined): ChangedProject[] {
  if (!summary) return [];

  return summary
    .split('\n')
    .map((line): ChangedProject | null => {
      const match = PROJECT_MR_LINE_PATTERN.exec(line);
      if (!match) return null;
      const name = normalizeProjectName(match[1]);
      const mrUrl = normalizeMrUrl(match[2]);
      return name && mrUrl ? { name, mrUrl } : null;
    })
    .filter((project): project is ChangedProject => Boolean(project));
}

export function getChangedProjects(feature: Feature): ChangedProject[] {
  const projects = normalizeChangedProjects(feature.changedProjects);
  const mergeRequests = normalizeMergeRequests(feature.mergeRequests);

  const linkedProjects = projects.map((project) => {
    if (project.mrUrl) return project;
    const mrUrl =
      mergeRequests.find((url) => projectMatchesUrl(project.name, url)) ??
      (projects.length === 1 && mergeRequests.length === 1 ? mergeRequests[0] : undefined);
    return mrUrl ? { ...project, mrUrl } : project;
  });

  // Not every receipt records per-project names: AIP-114879 child-3 stored
  // `changedProjects: []` alongside a saas-frontend MR, so the project list was
  // empty even though an MR existed. Fall back to the repository named in the
  // MR URL when the receipt carries no project entries at all.
  const derivedFromMergeRequests =
    projects.length === 0
      ? mergeRequests
          .map((url): ChangedProject | null => {
            const name = deriveProjectNameFromMrUrl(url);
            return name ? { name, mrUrl: url } : null;
          })
          .filter((project): project is ChangedProject => Boolean(project))
      : [];

  return dedupeProjects(
    applyRealProjectNames([
      ...linkedProjects,
      ...derivedFromMergeRequests,
      ...parseSummaryProjects(feature.summary),
    ])
  ).map((project) => ({ ...project, name: shortenProjectName(project.name) }));
}

/** Normalize alternate GitLab URL spellings without conflating different hosts or MRs. */
function mrIdentity(mrUrl: string): string {
  const url = new URL(mrUrl);
  return `${url.origin}${url.pathname.replace(/\/-\/merge_requests\//, '/merge_requests/').replace(/\/$/, '')}`;
}

function dedupeProjects(projects: ChangedProject[]): ChangedProject[] {
  const seen = new Set<string>();
  const result: ChangedProject[] = [];
  const linkedNames = new Set(
    projects.filter((project) => project.mrUrl).map((project) => project.name)
  );
  for (const project of projects) {
    // Prefer a linked entry to an otherwise identical name-only receipt entry.
    if (!project.mrUrl && linkedNames.has(project.name)) continue;
    const key = project.mrUrl ? `mr:${mrIdentity(project.mrUrl)}` : `name:${project.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(project);
  }
  return result;
}

interface ChangedProjectListProps {
  featureId: string;
  projects: ChangedProject[];
  className?: string;
  /** Cards show the repositories straight away, without the section label. */
  showLabel?: boolean;
}

export const ChangedProjectList = memo(function ChangedProjectList({
  featureId,
  projects,
  className,
  showLabel = true,
}: ChangedProjectListProps) {
  if (projects.length === 0) return null;

  return (
    <div className={className} data-testid={`changed-projects-${featureId}`}>
      {showLabel && <span className="text-[10px] font-medium text-muted-foreground">改动项目</span>}
      <div className={showLabel ? 'mt-1 flex flex-wrap gap-1' : 'flex flex-wrap gap-1'}>
        {projects.map((project) => {
          const content = (
            <>
              <span className="truncate">{project.name}</span>
              {project.mrUrl && <ExternalLink className="ml-0.5 h-2.5 w-2.5 shrink-0" />}
            </>
          );

          return project.mrUrl ? (
            <a
              key={`${project.name}-${project.mrUrl}`}
              href={project.mrUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open MR for ${project.name}`}
              className="inline-flex max-w-full items-center gap-0.5 rounded bg-brand-500/10 px-1.5 py-0.5 text-[10px] text-brand-500 transition-colors hover:bg-brand-500/20"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {content}
            </a>
          ) : (
            <span
              key={project.name}
              title={project.name}
              className="inline-flex max-w-full items-center rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {content}
            </span>
          );
        })}
      </div>
    </div>
  );
});
