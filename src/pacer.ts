/**
 * Pacing state for agents that gather with tools, kept separate from the OpenClaw wiring so it can be tested on its own.
 *
 * The pacer never blocks anything. For each run of a configured agent it counts gathering tool results (search,
 * fetch), notices when a note is written, and returns one status line to append to the next gathering result. The
 * context share comes from the budget and usage OpenClaw reports for the run, so nothing about the model is
 * hard-coded.
 */
import { isRecord } from './tool-result.ts';

export interface NotesConfig {
  /** A write counts as a note when its path contains this text. Unset means note tracking is off. */
  pathContains?: string;
  /** Tools that can write a note. */
  tools: string[];
  /** Ask for a note once this many gathering results pass without one. */
  everyResults: number;
}

export interface OffloadConfig {
  /** Save large gathering results to the workspace the agent's tools run in and show an excerpt instead. Off by default. */
  enabled: boolean;
  /** Offload a result once the text the model would see exceeds this many characters. */
  thresholdChars: number;
  /** Characters of the saved result shown in its place. */
  excerptChars: number;
  /**
   * Workspace-relative folder for saved results, with one subfolder per run. It has to be inside the workspace the
   * agent's tools run in, because that is the only place a sandboxed agent can read.
   */
  directory: string;
  /** Run folders kept in the directory; older ones the pacer created are deleted. */
  maxRuns: number;
  /**
   * Most bytes saved per run (per attempt with the conversation-access grant); past this, results pass through
   * unchanged.
   */
  maxBytesPerRun: number;
}

export interface PacerConfig {
  /** Agent ids the pacer applies to. Empty (the default) paces no agent. */
  agents: string[];
  /** Tools whose results count as gathering and receive the status line. */
  gatherTools: string[];
  notes: NotesConfig;
  /** Share of the context budget at which the line says to stop gathering. */
  wrapUpContextFraction: number;
  /** Most runs tracked in memory at once; the one idle longest is dropped beyond this. */
  maxTrackedRuns: number;
  offload: OffloadConfig;
}

export const DEFAULTS: PacerConfig = {
  agents: [],
  gatherTools: ['web_search', 'web_fetch'],
  notes: { tools: ['write', 'edit'], everyResults: 3 },
  wrapUpContextFraction: 0.6,
  maxTrackedRuns: 50,
  offload: {
    enabled: false,
    thresholdChars: 6000,
    excerptChars: 4000,
    directory: '.context-pacer',
    maxRuns: 10,
    maxBytesPerRun: 25_000_000,
  },
};

interface RunState {
  gathers: number;
  notes: number;
  sinceNote: number;
  promptTokens?: number;
  /** True when promptTokens is estimated from request size rather than reported usage. */
  approx?: boolean;
  budget?: number;
  savedBytes: number;
  /** Saved-file folder, named when the run first saves so a run past midnight keeps one folder. */
  folder?: string;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringList(value: unknown, fallback: string[], allowEmpty = false): string[] {
  const valid = Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
  return valid && (allowEmpty || value.length > 0) ? [...value] : [...fallback];
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A relative path of plain segments, so saved files can't land outside the agent's workspace. */
function directoryPath(value: unknown): string {
  const fallback = DEFAULTS.offload.directory;
  if (typeof value !== 'string') {
    return fallback;
  }
  const segments = value.split('/').filter((s) => s.length > 0);
  const plain = segments.length > 0 && segments.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && !/^\.+$/.test(s));
  return plain && !value.startsWith('/') ? segments.join('/') : fallback;
}

/** Reads `plugins.entries.context-pacer.config`; anything missing or invalid falls back to the default. */
export function resolveConfig(raw: unknown): PacerConfig {
  const c = record(raw);
  const n = record(c.notes);
  const o = record(c.offload);
  const thresholdChars = Math.round(clamp(o.thresholdChars, 1000, 100_000, DEFAULTS.offload.thresholdChars));
  const excerptChars = Math.round(clamp(o.excerptChars, 500, 20_000, DEFAULTS.offload.excerptChars));
  return {
    agents: stringList(c.agents, DEFAULTS.agents, true),
    gatherTools: stringList(c.gatherTools, DEFAULTS.gatherTools),
    notes: {
      ...(typeof n.pathContains === 'string' && n.pathContains.length > 0 ? { pathContains: n.pathContains } : {}),
      tools: stringList(n.tools, DEFAULTS.notes.tools),
      everyResults: Math.round(clamp(n.everyResults, 1, 20, DEFAULTS.notes.everyResults)),
    },
    wrapUpContextFraction: clamp(c.wrapUpContextFraction, 0.2, 0.95, DEFAULTS.wrapUpContextFraction),
    maxTrackedRuns: Math.round(clamp(c.maxTrackedRuns, 1, 1000, DEFAULTS.maxTrackedRuns)),
    offload: {
      enabled: o.enabled === true,
      thresholdChars,
      // An excerpt close to the threshold would save almost nothing.
      excerptChars: Math.min(excerptChars, Math.max(500, thresholdChars - 1000)),
      directory: directoryPath(o.directory),
      maxRuns: Math.round(clamp(o.maxRuns, 1, 100, DEFAULTS.offload.maxRuns)),
      maxBytesPerRun: Math.round(clamp(o.maxBytesPerRun, 1_000_000, 500_000_000, DEFAULTS.offload.maxBytesPerRun)),
    },
  };
}

function writePath(args: unknown): string | undefined {
  const a = record(args);
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const value = a[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

export class Pacer {
  readonly config: PacerConfig;
  private readonly runs = new Map<string, RunState>();

  constructor(config: PacerConfig) {
    this.config = config;
  }

  applies(agentId: string | undefined): boolean {
    return typeof agentId === 'string' && this.config.agents.includes(agentId);
  }

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (s) {
      // Re-inserting keeps the map in order of last use, so eviction drops the idlest run, not one still saving.
      this.runs.delete(runId);
      this.runs.set(runId, s);
    } else {
      s = { gathers: 0, notes: 0, sinceNote: 0, savedBytes: 0 };
      this.runs.set(runId, s);
      for (const idlest of this.runs.keys()) {
        if (this.runs.size <= this.config.maxTrackedRuns) {
          break;
        }
        this.runs.delete(idlest);
      }
    }
    return s;
  }

  /**
   * Records the run's resolved context budget and the prompt size of its latest model call. `approx` marks a size
   * estimated from request bytes; it never replaces a reported size from the same or a later call.
   */
  recordUsage(runId: string, budget?: number, promptTokens?: number, approx = false): void {
    const s = this.state(runId);
    if (typeof budget === 'number' && budget > 0) {
      s.budget = budget;
    }
    if (typeof promptTokens !== 'number' || promptTokens <= 0) {
      return;
    }
    if (approx && s.promptTokens !== undefined && !s.approx && promptTokens <= s.promptTokens) {
      return;
    }
    s.promptTokens = promptTokens;
    s.approx = approx;
  }

  /**
   * Returns the status line for a gathering result, or undefined when the result should pass unchanged. A `failed`
   * write is not a note.
   */
  onToolResult(runId: string, toolName: string, args: unknown, failed = false): string | undefined {
    const { gatherTools, notes } = this.config;
    if (notes.tools.includes(toolName)) {
      const path = writePath(args);
      if (!failed && notes.pathContains && path && path.includes(notes.pathContains)) {
        const s = this.state(runId);
        s.notes += 1;
        s.sinceNote = 0;
      }
      return undefined;
    }
    if (!gatherTools.includes(toolName)) {
      return undefined;
    }
    const s = this.state(runId);
    s.gathers += 1;
    s.sinceNote += 1;
    return statusLine(s, this.config);
  }

  /** Number of the run's latest gathering result, used to name its saved file. */
  gatherIndex(runId: string): number {
    return this.state(runId).gathers;
  }

  /** The run's saved-file folder: made by `make` the first time, then the same name for the rest of the run. */
  folderFor(runId: string, make: () => string): string {
    const s = this.state(runId);
    s.folder ??= make();
    return s.folder;
  }

  /** Save folders of the runs still tracked. Without `agent_end`, a run counts until `maxTrackedRuns` drops it. */
  liveFolders(): Set<string> {
    const folders = new Set<string>();
    for (const s of this.runs.values()) {
      if (s.folder !== undefined) {
        folders.add(s.folder);
      }
    }
    return folders;
  }

  /** Reserves room for a saved file within the run's byte limit; false means don't save it. */
  reserveBytes(runId: string, bytes: number): boolean {
    const s = this.state(runId);
    if (s.savedBytes + bytes > this.config.offload.maxBytesPerRun) {
      return false;
    }
    s.savedBytes += bytes;
    return true;
  }

  /** Returns bytes reserved for a save that failed. */
  releaseBytes(runId: string, bytes: number): void {
    const s = this.state(runId);
    s.savedBytes = Math.max(0, s.savedBytes - bytes);
  }

  end(runId: string): void {
    this.runs.delete(runId);
  }

  get trackedRuns(): number {
    return this.runs.size;
  }
}

export function contextShare(s: Pick<RunState, 'promptTokens' | 'budget'>): number | undefined {
  return s.promptTokens && s.budget ? s.promptTokens / s.budget : undefined;
}

export function statusLine(s: Omit<RunState, 'savedBytes' | 'folder'>, config: PacerConfig): string {
  const share = contextShare(s);
  const tracking = config.notes.pathContains !== undefined;
  const parts = [`${s.gathers} gathering result${s.gathers === 1 ? '' : 's'} so far`];
  if (tracking) {
    parts.push(s.notes === 0 ? 'no notes written yet' : `last note ${s.sinceNote} result${s.sinceNote === 1 ? '' : 's'} ago`);
  }
  if (share !== undefined) {
    parts.push(`context about ${Math.round(share * 100)}% of budget${s.approx ? ' (approx)' : ''}`);
  }
  let advice = '';
  if (share !== undefined && share >= config.wrapUpContextFraction) {
    advice = ` Context is filling up: stop gathering and write the answer${tracking ? ' from your notes' : ''}.`;
  } else if (tracking && s.sinceNote >= config.notes.everyResults) {
    advice = ' Add what these sources showed to your notes before gathering more.';
  }
  return `[pacer] ${parts.join(' · ')}.${advice}`;
}

/** Appends the status line as a separate text block, leaving the tool's own content untouched. */
export function appendStatus<T extends { content?: unknown }>(result: T, line: string): T {
  const content = Array.isArray(result.content) ? result.content : [];
  return { ...result, content: [...content, { type: 'text', text: line }] };
}
