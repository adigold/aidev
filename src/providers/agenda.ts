import * as os from 'node:os';
import { Task, Comment, Config, CreateTaskParams, CreateTaskResult, FetchTasksOptions } from '../types';
import { TaskProvider } from './base';
import { logger } from '../logger';
import { taskMatchesTag } from '../providerViews';

/**
 * AGenda provider.
 *
 * AGenda is a self-hosted issue tracker with an "@aidev" job queue: when the
 * owner writes `@aidev` on an issue, the server queues a job. This provider
 * treats that queue as the task list and mirrors the Linear provider's flow:
 *
 * - `fetchTasks()` lists the open jobs of one workspace (one task per job).
 * - `updateStatus()` maps aidev's "in progress" / pending / in-review
 *   transitions onto the job queue (`claim`, then `report` running /
 *   needs_input / done), which is what moves the issue along and lets the
 *   server send its own notifications. Any other status name is written to the
 *   issue's workflow state, exactly like Linear.
 * - `postComment()` / `getComments()` use the issue's comment endpoints.
 *
 * Tags are the issue's labels. `AGENDA_LABEL` filters jobs by label like
 * `LINEAR_LABEL`; with the default `*` every @aidev job of the workspace is
 * this project's work, and the provider marks each task with the project tag
 * (`CLICKUP_TAG`, default: folder name) so aidev's tag checks during a run
 * see the same task it picked up.
 */

const DEFAULT_URL = 'http://127.0.0.1:7420';
const CLIENT_HEADER = 'aidev-dispatcher';
const AIDEV_ACTOR = 'AIdev';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job statuses that still need a dispatcher. */
export const AGENDA_OPEN_JOB_STATUSES = ['queued', 'claimed', 'running', 'needs_input'];

const STATE_TYPE_BY_GENERIC: Record<string, string> = {
  pending: 'backlog',
  backlog: 'backlog',
  todo: 'unstarted',
  open: 'unstarted',
  unstarted: 'unstarted',
  'in progress': 'started',
  started: 'started',
  review: 'started',
  done: 'completed',
  closed: 'completed',
  completed: 'completed',
  cancelled: 'canceled',
  canceled: 'canceled',
};

export interface AgendaJob {
  id: string;
  issue_id: string;
  identifier: string | null;
  issue_title: string | null;
  workspace_id: string | null;
  kind: string;
  requested_text: string;
  status: string;
  claimed_by: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  project_path: string | null;
}

interface AgendaIssue {
  id: string;
  identifier: string;
  team_id: string;
  title: string;
  description: string;
  state_id: string;
  priority: number;
  label_ids: string[];
  parent_id: string | null;
  workspace_id: string | null;
  updated_at: string;
}

export interface AgendaRelation {
  type: string;
  direction: 'outgoing' | 'incoming' | string;
  issue: { identifier: string };
}

interface AgendaComment {
  id: string;
  body: string;
  created_at: string;
  author: string | null;
  actor: string | null;
}

interface AgendaIssueDetail extends AgendaIssue {
  comments: AgendaComment[];
  relations: AgendaRelation[];
}

interface AgendaState {
  id: string;
  team_id: string;
  name: string;
  type: string;
}

interface AgendaLabel {
  id: string;
  name: string;
}

interface AgendaTeam {
  id: string;
  key: string;
  name: string;
  workspace_id: string | null;
  position?: number;
}

interface AgendaBootstrap {
  teams: AgendaTeam[];
  states: AgendaState[];
  labels: AgendaLabel[];
}

interface AgendaWorkspace {
  id: string;
  name: string;
}

interface AgendaReport {
  status: 'running' | 'needs_input' | 'done' | 'failed';
  branch?: string;
  summary?: string;
  question?: string;
  error?: string;
}

/**
 * Maps an AGenda job status to the status vocabulary aidev's run loop expects.
 * A queued job is "open" work; a queued `reply` job is the owner's answer to a
 * question, so it is reported as pending (aidev then reads the conversation).
 * A job waiting for an answer is neither open nor pending, so aidev skips it.
 */
export function mapAgendaJobStatus(job: Pick<AgendaJob, 'status' | 'kind'>, pendingStatus: string): string {
  switch (job.status) {
    case 'queued':
      return job.kind === 'reply' ? pendingStatus : 'open';
    case 'claimed':
    case 'running':
      return 'in progress';
    case 'needs_input':
      return 'needs input';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    default:
      return job.status;
  }
}

/** An issue is blocked by the issues that point at it with a `blocks` relation. */
export function getBlockedByFromAgendaRelations(relations: AgendaRelation[] | undefined): string[] {
  const blockedBy: string[] = [];
  for (const r of relations ?? []) {
    if (!r.issue?.identifier) continue;
    if (r.type === 'blocks' && r.direction === 'incoming') {
      blockedBy.push(r.issue.identifier);
    } else if ((r.type === 'blocked_by' || r.type === 'blocked') && r.direction === 'outgoing') {
      blockedBy.push(r.issue.identifier);
    }
  }
  return blockedBy;
}

export class AgendaProvider implements TaskProvider {
  private baseUrl: string;
  private token: string;
  private workspaceInput: string;
  private resolvedWorkspaceId: string | null = null;
  private bootstrapCache: AgendaBootstrap | null = null;
  private pendingStatus: string;
  private inReviewStatus: string;
  private commentPrefix: string;
  private claimedBy: string;
  /** Label filter (`*` = every job of the workspace). */
  private label: string;
  /** Tag every listed task carries so the run loop's tag checks match. */
  private projectTag: string;
  /** Jobs this provider claimed or reported on, by issue identifier. */
  private workingJobs = new Map<string, string>();

  constructor(config: Config) {
    this.baseUrl = (config.agendaUrl || DEFAULT_URL).replace(/\/+$/, '');
    this.token = config.agendaToken;
    this.workspaceInput = config.agendaWorkspaceId;
    this.pendingStatus = config.agendaPendingStatus || 'Pending';
    this.inReviewStatus = config.agendaInReviewStatus || 'In Review';
    this.commentPrefix = config.commentPrefix || '[aidev]';
    this.claimedBy = `aidev@${os.hostname()}`;
    this.label = (config.agendaLabel || '*').trim() || '*';
    this.projectTag = this.label !== '*' ? this.label : (config.clickupTag || '').trim();
  }

  private matchesLabel(tags: string[]): boolean {
    return taskMatchesTag(tags, this.label);
  }

  /** Issue labels plus the project tag (an @aidev job is this project's assignment). */
  private withProjectTag(tags: string[]): string[] {
    if (!this.projectTag || this.projectTag === '*') return tags;
    const want = this.projectTag.toLowerCase();
    return tags.some((t) => t.toLowerCase() === want) ? tags : [...tags, this.projectTag];
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Agenda-Client': CLIENT_HEADER,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const err = parsed as { error?: { message?: string; code?: string } | string } | undefined;
      const detail =
        typeof err?.error === 'string'
          ? err.error
          : err?.error?.message || (text ? text.slice(0, 200) : res.statusText);
      throw new Error(`AGenda API error ${res.status}: ${detail}`);
    }
    return parsed as T;
  }

  private async resolveWorkspaceId(): Promise<string> {
    if (this.resolvedWorkspaceId) return this.resolvedWorkspaceId;
    if (!this.workspaceInput) {
      throw new Error('AGenda: AGENDA_WORKSPACE_ID is not set');
    }
    if (UUID_REGEX.test(this.workspaceInput)) {
      this.resolvedWorkspaceId = this.workspaceInput;
      return this.resolvedWorkspaceId;
    }
    // Dispatcher keys may read /api/bootstrap but not /api/workspaces.
    const data = await this.request<{ workspaces: AgendaWorkspace[] }>('GET', '/api/bootstrap');
    const want = this.workspaceInput.trim().toLowerCase();
    const match = (data.workspaces ?? []).find((w) => w.id === this.workspaceInput || w.name.toLowerCase() === want);
    if (!match) {
      throw new Error(
        `AGenda: could not resolve AGENDA_WORKSPACE_ID "${this.workspaceInput}". Set it to the workspace id or its exact name.`,
      );
    }
    this.resolvedWorkspaceId = match.id;
    return this.resolvedWorkspaceId;
  }

  private async bootstrap(): Promise<AgendaBootstrap> {
    if (this.bootstrapCache) return this.bootstrapCache;
    const ws = await this.resolveWorkspaceId();
    const data = await this.request<AgendaBootstrap>('GET', `/api/bootstrap?workspace_id=${encodeURIComponent(ws)}`);
    this.bootstrapCache = {
      teams: (data.teams ?? []).filter((t) => !t.workspace_id || t.workspace_id === ws),
      states: data.states ?? [],
      labels: data.labels ?? [],
    };
    return this.bootstrapCache;
  }

  private async fetchJobs(statuses: string[], issue?: string): Promise<AgendaJob[]> {
    const ws = await this.resolveWorkspaceId();
    const params = new URLSearchParams();
    if (statuses.length) params.set('status', statuses.join(','));
    params.set('workspace_id', ws);
    if (issue) params.set('issue', issue);
    const data = await this.request<{ items: AgendaJob[] }>('GET', `/api/aidev/jobs?${params.toString()}`);
    return data.items ?? [];
  }

  private async fetchIssue(identifier: string): Promise<AgendaIssueDetail> {
    return this.request<AgendaIssueDetail>('GET', `/api/issues/${encodeURIComponent(identifier)}`);
  }

  private async openJob(identifier: string): Promise<AgendaJob | null> {
    const jobs = await this.fetchJobs(AGENDA_OPEN_JOB_STATUSES, identifier);
    return jobs.length ? jobs[jobs.length - 1] : null;
  }

  private async ensureClaimed(job: AgendaJob): Promise<AgendaJob> {
    if (job.status !== 'queued') return job;
    logger.debug(`Claiming AGenda job ${job.id} for ${job.identifier ?? job.issue_id}`);
    return this.request<AgendaJob>('POST', `/api/aidev/jobs/${encodeURIComponent(job.id)}/claim`, { by: this.claimedBy });
  }

  private async report(jobId: string, body: AgendaReport): Promise<AgendaJob> {
    logger.debug(`Reporting AGenda job ${jobId} as ${body.status}`);
    return this.request<AgendaJob>('POST', `/api/aidev/jobs/${encodeURIComponent(jobId)}/report`, body);
  }

  // ── Mapping ─────────────────────────────────────────────────────────────

  private issueUrl(identifier: string): string {
    return `${this.baseUrl}/issue/${encodeURIComponent(identifier)}`;
  }

  private async labelNames(labelIds: string[]): Promise<string[]> {
    if (!labelIds?.length) return [];
    const { labels } = await this.bootstrap();
    const byId = new Map(labels.map((l) => [l.id, l.name]));
    return labelIds.map((id) => byId.get(id)).filter((n): n is string => Boolean(n));
  }

  private async stateName(stateId: string): Promise<string> {
    const { states } = await this.bootstrap();
    return states.find((s) => s.id === stateId)?.name ?? stateId;
  }

  /**
   * Maps an issue to a task. With `applyLabelFilter`, returns null when the
   * issue's own labels do not match `AGENDA_LABEL` (the filter looks at the
   * real labels, before the project tag is added).
   */
  private async mapIssue(
    issue: AgendaIssueDetail | AgendaIssue,
    status: string,
    ws: string,
    omitDescription: boolean,
    applyLabelFilter = false,
  ): Promise<Task | null> {
    const labels = await this.labelNames(issue.label_ids);
    if (applyLabelFilter && !this.matchesLabel(labels)) return null;
    const relations = (issue as AgendaIssueDetail).relations;
    const blockedBy = getBlockedByFromAgendaRelations(relations);
    return {
      id: issue.identifier,
      name: issue.title,
      description: omitDescription ? '' : issue.description || '',
      status,
      url: this.issueUrl(issue.identifier),
      tags: this.withProjectTag(labels),
      priority: typeof issue.priority === 'number' ? issue.priority : undefined,
      sourceListId: ws,
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
    };
  }

  private async mapJob(job: AgendaJob, ws: string, omitDescription: boolean, applyLabelFilter = false): Promise<Task | null> {
    const identifier = job.identifier ?? job.issue_id;
    const status = mapAgendaJobStatus(job, this.pendingStatus);
    let detail: AgendaIssueDetail | null = null;
    try {
      detail = await this.fetchIssue(identifier);
    } catch (err) {
      logger.warn(`AGenda: could not load issue ${identifier} for job ${job.id}: ${err instanceof Error ? err.message : err}`);
    }
    if (!detail) {
      if (applyLabelFilter && !this.matchesLabel([])) return null;
      return {
        id: identifier,
        name: job.issue_title ?? identifier,
        description: omitDescription ? '' : job.requested_text || '',
        status,
        url: this.issueUrl(identifier),
        tags: this.withProjectTag([]),
        sourceListId: ws,
      };
    }
    const task = await this.mapIssue(detail, status, ws, omitDescription, applyLabelFilter);
    if (!task) return null;
    if (!omitDescription) {
      // Jobs triggered from a comment carry the actual request in requested_text.
      const request = (job.requested_text || '').trim();
      if (request && !task.description.includes(request)) {
        task.description = task.description ? `${task.description}\n\nRequest (@aidev):\n${request}` : request;
      }
    }
    return task;
  }

  // ── TaskProvider ────────────────────────────────────────────────────────

  async fetchTasks(options?: FetchTasksOptions): Promise<Task[]> {
    const ws = await this.resolveWorkspaceId();
    logger.debug(`Fetching open AGenda @aidev jobs for workspace ${ws}`);
    let jobs = await this.fetchJobs(AGENDA_OPEN_JOB_STATUSES);
    if (options?.updatedAfter !== undefined) {
      const after = options.updatedAfter;
      jobs = jobs.filter((j) => new Date(j.updated_at).getTime() >= after);
    }
    const tasks: Task[] = [];
    for (const job of jobs) {
      const task = await this.mapJob(job, ws, Boolean(options?.omitDescription), true);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async fetchTaskById(taskId: string, options?: FetchTasksOptions): Promise<Task | null> {
    const ws = await this.resolveWorkspaceId();
    let detail: AgendaIssueDetail;
    try {
      detail = await this.fetchIssue(taskId);
    } catch (err) {
      if (err instanceof Error && /AGenda API error 404/.test(err.message)) return null;
      throw err;
    }
    const jobs = await this.fetchJobs([], detail.identifier);
    const open = jobs.filter((j) => AGENDA_OPEN_JOB_STATUSES.includes(j.status));
    if (open.length) {
      // A claimed / running job keeps reporting the same task (status "in
      // progress", same tags) for the whole run; the watcher re-reads it every
      // few seconds.
      return this.mapJob(open[open.length - 1], ws, Boolean(options?.omitDescription));
    }
    // The job this provider was working on ended outside aidev (canceled in
    // AGenda, or failed): report that so the run stops instead of reading the
    // issue's workflow state, which may still look active.
    const workingId = this.workingJobs.get(detail.identifier);
    const working = workingId ? jobs.find((j) => j.id === workingId) : undefined;
    if (working && working.status !== 'done') {
      return this.mapJob(working, ws, Boolean(options?.omitDescription));
    }
    const status = await this.stateName(detail.state_id);
    return this.mapIssue(detail, status, ws, Boolean(options?.omitDescription));
  }

  /** Issues sitting in the in-review workflow state (their jobs are already done). */
  private async fetchReviewTasks(ws: string): Promise<Task[]> {
    const { states } = await this.bootstrap();
    const want = this.inReviewStatus.toLowerCase();
    const stateIds = states.filter((s) => s.name.toLowerCase() === want).map((s) => s.id);
    if (stateIds.length === 0) return [];
    const params = new URLSearchParams({
      workspace_id: ws,
      state_id: stateIds.join(','),
      fields: 'full',
      limit: '200',
    });
    const data = await this.request<{ items: AgendaIssue[] }>('GET', `/api/issues?${params.toString()}`);
    const tasks: Task[] = [];
    for (const issue of data.items ?? []) {
      const task = await this.mapIssue(issue, await this.stateName(issue.state_id), ws, true, true);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async fetchTasksByStatus(statuses: string[], options?: FetchTasksOptions): Promise<Task[]> {
    const normalized = statuses.map((s) => s.toLowerCase());
    const ws = await this.resolveWorkspaceId();
    const all = await this.fetchTasks(options);
    const byId = new Map<string, Task>();
    if (normalized.includes(this.inReviewStatus.toLowerCase())) {
      try {
        for (const t of await this.fetchReviewTasks(ws)) byId.set(t.id, t);
      } catch (err) {
        logger.warn(`Failed to fetch AGenda review issues: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const t of all) {
      if (normalized.includes(t.status.toLowerCase())) byId.set(t.id, t);
    }
    return [...byId.values()];
  }

  async fetchBoardTasks(_options?: FetchTasksOptions): Promise<Task[]> {
    const ws = await this.resolveWorkspaceId();
    const open = await this.fetchTasks({ skipAttachments: true, omitDescription: true });
    let review: Task[] = [];
    try {
      review = await this.fetchReviewTasks(ws);
    } catch (err) {
      logger.warn(`Failed to fetch AGenda review issues: ${err instanceof Error ? err.message : err}`);
    }
    const byId = new Map<string, Task>();
    for (const t of review) byId.set(t.id, t);
    for (const t of open) byId.set(t.id, t);
    return [...byId.values()];
  }

  async postComment(taskId: string, text: string): Promise<void> {
    logger.debug(`Posting comment to AGenda issue ${taskId}`);
    await this.request('POST', `/api/issues/${encodeURIComponent(taskId)}/comments`, { body: text });
  }

  async getComments(taskId: string): Promise<Comment[]> {
    logger.debug(`Fetching comments for AGenda issue ${taskId}`);
    const detail = await this.fetchIssue(taskId);
    const sorted = [...(detail.comments ?? [])].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    return sorted.map((c) => {
      let text = c.body || '';
      // Comments the AGenda server writes on aidev's behalf (job reports) carry
      // the AIdev actor instead of aidev's comment prefix; mark them so the run
      // loop does not mistake them for human replies.
      if (c.actor === AIDEV_ACTOR && !text.trimStart().startsWith(this.commentPrefix)) {
        text = `${this.commentPrefix} ${text}`;
      }
      const author = c.author || c.actor || 'Unknown';
      return {
        id: c.id,
        text,
        author,
        authorId: c.actor ?? c.author ?? '',
        date: new Date(c.created_at).getTime(),
      };
    });
  }

  async fetchAvailableStatuses(): Promise<string[]> {
    const { states } = await this.bootstrap();
    const names: string[] = [];
    for (const s of states) {
      if (!names.some((n) => n.toLowerCase() === s.name.toLowerCase())) names.push(s.name);
    }
    const hasCompleted = states.some((s) => s.type === 'completed');
    if (hasCompleted && !names.some((n) => n.toLowerCase() === 'done')) {
      names.push('done');
    }
    return names;
  }

  private async setIssueState(taskId: string, status: string): Promise<void> {
    const detail = await this.fetchIssue(taskId);
    const { states } = await this.bootstrap();
    const teamStates = states.filter((s) => s.team_id === detail.team_id);
    const key = status.toLowerCase();
    let stateId = teamStates.find((s) => s.name.toLowerCase() === key)?.id;
    if (!stateId) {
      stateId = teamStates.find((s) => s.name.toLowerCase().includes(key))?.id;
    }
    if (!stateId) {
      const targetType = STATE_TYPE_BY_GENERIC[key];
      if (targetType) {
        stateId = teamStates.find((s) => s.type === targetType)?.id;
      }
    }
    if (!stateId) {
      const names = teamStates.map((s) => s.name).join(', ');
      const types = [...new Set(teamStates.map((s) => s.type))].join(', ');
      throw new Error(
        `AGenda: no workflow state matching "${status}". Available names: ${names}. Available types: ${types}`,
      );
    }
    if (stateId === detail.state_id) return;
    await this.request('PATCH', `/api/issues/${encodeURIComponent(detail.id)}`, { state_id: stateId });
  }

  async updateStatus(taskId: string, status: string): Promise<void> {
    logger.debug(`Updating AGenda issue ${taskId} status to "${status}"`);
    const key = status.trim().toLowerCase();
    const job = await this.openJob(taskId);
    if (job) {
      if (key === 'in progress') {
        const claimed = await this.ensureClaimed(job);
        this.workingJobs.set(taskId, claimed.id);
        if (claimed.status !== 'running') await this.report(claimed.id, { status: 'running' });
        return;
      }
      if (key === this.pendingStatus.toLowerCase()) {
        const claimed = await this.ensureClaimed(job);
        this.workingJobs.delete(taskId);
        if (claimed.status !== 'needs_input') await this.report(claimed.id, { status: 'needs_input' });
        return;
      }
      if (key === this.inReviewStatus.toLowerCase()) {
        const claimed = await this.ensureClaimed(job);
        this.workingJobs.delete(taskId);
        await this.report(claimed.id, { status: 'done' });
        return;
      }
    }
    await this.setIssueState(taskId, status);
  }

  async addTag(taskId: string, tag: string): Promise<void> {
    logger.debug(`Adding label "${tag}" to AGenda issue ${taskId}`);
    await this.request('PATCH', `/api/issues/${encodeURIComponent(taskId)}`, { add_labels: [tag] });
  }

  async removeTag(taskId: string, tag: string): Promise<void> {
    logger.debug(`Removing label "${tag}" from AGenda issue ${taskId}`);
    await this.request('PATCH', `/api/issues/${encodeURIComponent(taskId)}`, { remove_labels: [tag] });
  }

  async deleteTask(taskId: string): Promise<void> {
    logger.debug(`Deleting AGenda issue ${taskId}`);
    await this.request('DELETE', `/api/issues/${encodeURIComponent(taskId)}`);
  }

  async createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
    const ws = await this.resolveWorkspaceId();
    const { teams } = await this.bootstrap();
    if (teams.length === 0) {
      throw new Error(`AGenda: workspace ${ws} has no team to create issues in`);
    }
    const wanted = (params.listId || '').trim().toLowerCase();
    const team =
      (wanted && teams.find((t) => t.id.toLowerCase() === wanted || t.key.toLowerCase() === wanted)) ||
      [...teams].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
    const input: Record<string, unknown> = {
      team_id: team.id,
      title: params.title,
    };
    if (params.description) input.description = params.description;
    if (params.priority !== undefined) input.priority = params.priority;
    const labels = (params.tags ?? []).map((t) => t.trim()).filter(Boolean);
    if (labels.length) input.labels = labels;
    const issue = await this.request<AgendaIssue>('POST', '/api/issues', input);
    if (!issue?.identifier) {
      throw new Error('AGenda: issue create did not return an issue');
    }
    return { id: issue.identifier, url: this.issueUrl(issue.identifier) };
  }
}
