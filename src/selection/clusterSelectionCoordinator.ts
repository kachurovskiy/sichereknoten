import { clusterLocationText } from "../domain/clusterDisplay";
import {
  createInteractionTelemetry,
  finishInteractionStep,
  logInteractionTelemetry,
  measureInteractionStep,
  startInteractionStep,
  type InteractionTelemetry,
  type TelemetryMetadata
} from "../shared/telemetry";
import type { IntersectionCluster } from "../domain/types";

export type SeverityFilterKey = "fatal" | "serious" | "other";
type ClusterSelectionViewKey = "map" | "details";

export interface ClusterSelectionCoordinatorDependencies {
  getActiveView: () => string;
  isMobileLayout: () => boolean;
  setView: (view: ClusterSelectionViewKey) => void;
  mapSelect: (cluster: IntersectionCluster, focus: boolean, reason: "program", zoomLevel: number | null) => void;
  ensureSeverityVisible: (cluster: IntersectionCluster) => void;
  scheduleFrame: (work: () => void) => void;
}

export class ClusterSelectionCoordinator {
  private activeInteractionTelemetry: InteractionTelemetry | null = null;

  constructor(private readonly deps: ClusterSelectionCoordinatorDependencies) {}

  selectCluster(cluster: IntersectionCluster, telemetrySource = "cluster selection", zoomLevel: number | null = null): void {
    const telemetry = createInteractionTelemetry("select cluster from list", telemetrySource, cluster.id, clusterLocationText(cluster));
    this.activeInteractionTelemetry = telemetry;
    const openDetailsOnMobile = this.deps.isMobileLayout();
    measureInteractionStep(telemetry, "ensure severity visible", cluster.id, () => this.deps.ensureSeverityVisible(cluster), () => ({
      severity: clusterSeverityKey(cluster),
      fatalCount: cluster.fatalCount,
      seriousCount: cluster.seriousCount
    }));
    if (!openDetailsOnMobile) {
      measureInteractionStep(telemetry, "set view to map", this.deps.getActiveView(), () => this.deps.setView("map"), () => ({
        activeView: this.deps.getActiveView()
      }));
    }
    const frameStep = startInteractionStep(telemetry, "wait for selection animation frame", cluster.id);
    this.deps.scheduleFrame(() => {
      finishInteractionStep(frameStep, {});
      try {
        this.withInteractionTelemetry(telemetry, () => {
          measureInteractionStep(
            telemetry,
            "map select, focus, draw, callback",
            cluster.id,
            () => this.deps.mapSelect(cluster, true, "program", zoomLevel),
            () => ({
              clusterId: cluster.id,
              accidentCount: cluster.accidentCount
            })
          );
          if (openDetailsOnMobile) {
            measureInteractionStep(telemetry, "mobile set view details", cluster.id, () => this.deps.setView("details"), () => ({
              activeView: this.deps.getActiveView()
            }));
          }
        });
      } finally {
        this.scheduleInteractionTelemetryLog(telemetry);
      }
    });
  }

  measureActiveInteractionStep<T>(
    name: string,
    detail: string | null,
    work: () => T,
    metadata?: (result: T) => TelemetryMetadata
  ): T {
    const telemetry = this.activeInteractionTelemetry;
    return telemetry ? measureInteractionStep(telemetry, name, detail, work, metadata) : work();
  }

  private withInteractionTelemetry<T>(telemetry: InteractionTelemetry, work: () => T): T {
    const previous = this.activeInteractionTelemetry;
    this.activeInteractionTelemetry = telemetry;
    try {
      return work();
    } finally {
      this.activeInteractionTelemetry = previous;
    }
  }

  private scheduleInteractionTelemetryLog(telemetry: InteractionTelemetry): void {
    const paintStep = startInteractionStep(telemetry, "wait for browser paint", telemetry.clusterId);
    this.deps.scheduleFrame(() => {
      this.deps.scheduleFrame(() => {
        finishInteractionStep(paintStep, { activeView: this.deps.getActiveView() });
        logInteractionTelemetry(telemetry, { activeView: this.deps.getActiveView() });
        if (this.activeInteractionTelemetry === telemetry) {
          this.activeInteractionTelemetry = null;
        }
      });
    });
  }
}

export function clusterSeverityKey(cluster: IntersectionCluster): SeverityFilterKey {
  if (cluster.fatalCount > 0) {
    return "fatal";
  }
  if (cluster.seriousCount > 0) {
    return "serious";
  }
  return "other";
}
