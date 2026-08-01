export type InitializationTelemetryStatus = "running" | "done" | "error";
export type TelemetryMetadata = Record<string, string | number | boolean | null>;

export interface InitializationTelemetry {
  startedAt: string;
  startMark: number;
  appVersion: string;
  dataVersion: string | null;
  steps: InitializationTelemetryStep[];
  logged: boolean;
}

export interface InitializationTelemetryStep {
  name: string;
  detail: string | null;
  startTime: string;
  startMark: number;
  startOffsetMs: number;
  durationMs: number | null;
  status: InitializationTelemetryStatus;
  metadata: TelemetryMetadata;
}

export interface InteractionTelemetry {
  label: string;
  source: string;
  startedAt: string;
  startMark: number;
  clusterId: string | null;
  clusterLabel: string | null;
  steps: InteractionTelemetryStep[];
  logged: boolean;
}

export interface InteractionTelemetryStep {
  name: string;
  detail: string | null;
  startTime: string;
  startMark: number;
  startOffsetMs: number;
  durationMs: number | null;
  metadata: TelemetryMetadata;
}

export function createInitializationTelemetry(appVersion: string): InitializationTelemetry {
  return {
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    appVersion,
    dataVersion: null,
    steps: [],
    logged: false
  };
}

export function createPostRenderCacheTelemetry(source: InitializationTelemetry | null): InitializationTelemetry | null {
  if (!source) {
    return null;
  }

  return {
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    appVersion: source.appVersion,
    dataVersion: source.dataVersion,
    steps: [],
    logged: false
  };
}

export function recordInitializationStep(
  telemetry: InitializationTelemetry | null,
  name: string,
  detail: string | null,
  metadata: TelemetryMetadata
): void {
  if (!telemetry) {
    return;
  }

  const step = startInitializationStep(telemetry, name, detail);
  finishInitializationStep(step, "done", metadata);
}

export async function measureInitializationStep<T>(
  telemetry: InitializationTelemetry | null,
  name: string,
  detail: string | null,
  work: () => Promise<T>,
  metadata?: (result: T) => TelemetryMetadata
): Promise<T> {
  if (!telemetry) {
    return work();
  }

  const step = startInitializationStep(telemetry, name, detail);
  try {
    const result = await work();
    finishInitializationStep(step, "done", metadata?.(result) ?? {});
    return result;
  } catch (error) {
    finishInitializationStep(step, "error", { error: errorMessage(error) });
    throw error;
  }
}

export function logInitializationTelemetry(
  telemetry: InitializationTelemetry | null,
  status: Exclude<InitializationTelemetryStatus, "running">,
  label = "initialization telemetry"
): void {
  if (!telemetry || telemetry.logged) {
    return;
  }

  telemetry.logged = true;
  const finishedAt = new Date().toISOString();
  const durationMs = roundTelemetry(performance.now() - telemetry.startMark, 2);
  const summary = {
    status,
    appVersion: telemetry.appVersion,
    dataVersion: telemetry.dataVersion ?? "unknown",
    startedAt: telemetry.startedAt,
    finishedAt,
    durationMs,
    stepCount: telemetry.steps.length
  };
  const rows = telemetry.steps.map((step, index) => ({
    "#": index + 1,
    step: step.name,
    detail: step.detail ?? "",
    status: step.status,
    "start time": step.startTime,
    "start +ms": roundTelemetry(step.startOffsetMs, 2),
    "duration ms": step.durationMs === null ? null : roundTelemetry(step.durationMs, 2),
    ...step.metadata
  }));

  console.groupCollapsed(`[Safe Intersections] ${label}: ${status} in ${durationMs} ms`);
  console.info(summary);
  console.table(rows);
  console.groupEnd();
}

export function createInteractionTelemetry(
  label: string,
  source: string,
  clusterId: string | null,
  clusterLabel: string | null
): InteractionTelemetry {
  return {
    label,
    source,
    startedAt: new Date().toISOString(),
    startMark: performance.now(),
    clusterId,
    clusterLabel,
    steps: [],
    logged: false
  };
}

export function measureInteractionStep<T>(
  telemetry: InteractionTelemetry,
  name: string,
  detail: string | null,
  work: () => T,
  metadata?: (result: T) => TelemetryMetadata
): T {
  const step = startInteractionStep(telemetry, name, detail);
  try {
    const result = work();
    finishInteractionStep(step, metadata?.(result) ?? {});
    return result;
  } catch (error) {
    finishInteractionStep(step, { error: errorMessage(error) });
    throw error;
  }
}

export function startInteractionStep(telemetry: InteractionTelemetry, name: string, detail: string | null): InteractionTelemetryStep {
  const startMark = performance.now();
  const step: InteractionTelemetryStep = {
    name,
    detail,
    startTime: new Date().toISOString(),
    startMark,
    startOffsetMs: startMark - telemetry.startMark,
    durationMs: null,
    metadata: {}
  };
  telemetry.steps.push(step);
  return step;
}

export function finishInteractionStep(step: InteractionTelemetryStep, metadata: TelemetryMetadata): void {
  step.durationMs = performance.now() - step.startMark;
  step.metadata = metadata;
}

export function logInteractionTelemetry(telemetry: InteractionTelemetry, metadata: TelemetryMetadata = {}): void {
  if (telemetry.logged) {
    return;
  }

  telemetry.logged = true;
  const finishedAt = new Date().toISOString();
  const durationMs = roundTelemetry(performance.now() - telemetry.startMark, 2);
  const summary = {
    label: telemetry.label,
    source: telemetry.source,
    clusterId: telemetry.clusterId ?? "",
    cluster: telemetry.clusterLabel ?? "",
    startedAt: telemetry.startedAt,
    finishedAt,
    durationMs,
    stepCount: telemetry.steps.length,
    ...metadata
  };
  const rows = telemetry.steps.map((step, index) => ({
    "#": index + 1,
    step: step.name,
    detail: step.detail ?? "",
    "start time": step.startTime,
    "start +ms": roundTelemetry(step.startOffsetMs, 2),
    "duration ms": step.durationMs === null ? null : roundTelemetry(step.durationMs, 2),
    ...step.metadata
  }));

  console.groupCollapsed(`[Safe Intersections] interaction telemetry: ${telemetry.source} in ${durationMs} ms`);
  console.info(summary);
  console.table(rows);
  console.groupEnd();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startInitializationStep(telemetry: InitializationTelemetry, name: string, detail: string | null): InitializationTelemetryStep {
  const startMark = performance.now();
  const step: InitializationTelemetryStep = {
    name,
    detail,
    startTime: new Date().toISOString(),
    startMark,
    startOffsetMs: startMark - telemetry.startMark,
    durationMs: null,
    status: "running",
    metadata: {}
  };
  telemetry.steps.push(step);
  return step;
}

function finishInitializationStep(
  step: InitializationTelemetryStep,
  status: Exclude<InitializationTelemetryStatus, "running">,
  metadata: TelemetryMetadata
): void {
  step.durationMs = performance.now() - step.startMark;
  step.status = status;
  step.metadata = metadata;
}

function roundTelemetry(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
