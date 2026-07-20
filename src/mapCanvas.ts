import { IntersectionCluster, TrafficPoint } from "./types";

interface ProjectedPoint {
  x: number;
  y: number;
}

interface VisibleClusterPoint {
  cluster: IntersectionCluster;
  projected: ProjectedPoint;
  point: ProjectedPoint;
}

interface ProjectedCluster {
  cluster: IntersectionCluster;
  projected: ProjectedPoint;
}

type SelectionCallback = (cluster: IntersectionCluster | null) => void;

const MIN_SCALE = 250;
const MAX_SCALE = 80_000_000;
const CLICK_TOLERANCE_PX = 4;
const OVERVIEW_POINT_SCALE = 1_100_000;

export class MapCanvas {
  private readonly context: CanvasRenderingContext2D;
  private clusters: IntersectionCluster[] = [];
  private projectedClusters: ProjectedCluster[] = [];
  private traffic: TrafficPoint[] = [];
  private selected: IntersectionCluster | null = null;
  private maxDangerScore = 1;
  private showTraffic = true;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private bounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private dragging = false;
  private lastPointer: ProjectedPoint | null = null;
  private pointerDown: ProjectedPoint | null = null;
  private clickCycle: { x: number; y: number; index: number; candidates: IntersectionCluster[] } | null = null;
  private drawFrame: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly onSelect: SelectionCallback) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas rendering is not available.");
    }
    this.context = context;
    this.attachEvents();
    this.resizeToDisplaySize();
    window.addEventListener("resize", () => {
      this.resizeToDisplaySize();
      this.requestDraw();
    });
  }

  setData(clusters: IntersectionCluster[], traffic: TrafficPoint[]): void {
    this.clusters = clusters;
    this.projectedClusters = clusters
      .map((cluster) => ({ cluster, projected: project(cluster.lon, cluster.lat) }))
      .sort((a, b) => a.cluster.dangerScore - b.cluster.dangerScore);
    this.traffic = traffic;
    this.maxDangerScore = Math.max(1, ...clusters.map((cluster) => cluster.dangerScore));
    this.selected = clusters[0] ?? null;
    this.fit();
    this.draw();
    this.onSelect(this.selected);
  }

  setShowTraffic(showTraffic: boolean): void {
    this.showTraffic = showTraffic;
    this.draw();
  }

  select(cluster: IntersectionCluster | null, focus = false): void {
    this.selected = cluster;
    if (cluster && focus) {
      this.centerOn(cluster);
    }
    this.draw();
    this.onSelect(cluster);
  }

  zoom(factor: number): void {
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    this.scaleAt(centerX, centerY, factor);
  }

  reset(): void {
    this.fit();
    this.draw();
  }

  private attachEvents(): void {
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.32 : 0.76;
      this.scaleAt(event.offsetX * window.devicePixelRatio, event.offsetY * window.devicePixelRatio, factor);
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.pointerDown = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging || !this.lastPointer) {
        return;
      }
      const dx = (event.clientX - this.lastPointer.x) * window.devicePixelRatio;
      const dy = (event.clientY - this.lastPointer.y) * window.devicePixelRatio;
      this.offsetX += dx;
      this.offsetY += dy;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.requestDraw();
    });

    this.canvas.addEventListener("pointerup", (event) => {
      if (!this.dragging) {
        return;
      }
      this.dragging = false;
      this.lastPointer = null;
      this.canvas.releasePointerCapture(event.pointerId);
      const pointerMoved = this.pointerDown
        ? Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > CLICK_TOLERANCE_PX
        : false;
      this.pointerDown = null;
      if (pointerMoved) {
        return;
      }

      const cluster = this.findClusterAt(event.offsetX * window.devicePixelRatio, event.offsetY * window.devicePixelRatio);
      if (cluster) {
        this.select(cluster);
      }
    });
  }

  private fit(): void {
    if (this.projectedClusters.length === 0 && this.traffic.length === 0) {
      this.bounds = null;
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }

    const projected =
      this.projectedClusters.length > 0 ? this.projectedClusters.map((point) => point.projected) : this.traffic.map((point) => project(point.lon, point.lat));
    const minX = Math.min(...projected.map((point) => point.x));
    const maxX = Math.max(...projected.map((point) => point.x));
    const minY = Math.min(...projected.map((point) => point.y));
    const maxY = Math.max(...projected.map((point) => point.y));
    this.bounds = { minX, maxX, minY, maxY };
    const pad = 64 * window.devicePixelRatio;
    const width = Math.max(maxX - minX, 0.0001);
    const height = Math.max(maxY - minY, 0.0001);
    this.scale = Math.min((this.canvas.width - pad * 2) / width, (this.canvas.height - pad * 2) / height);
    this.offsetX = pad - minX * this.scale + (this.canvas.width - pad * 2 - width * this.scale) / 2;
    this.offsetY = pad - minY * this.scale + (this.canvas.height - pad * 2 - height * this.scale) / 2;
  }

  private draw(): void {
    this.resizeToDisplaySize();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#f4f1e8";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (!this.bounds || this.clusters.length === 0) {
      return;
    }

    if (this.showTraffic) {
      this.drawTrafficStations();
    }
    this.drawClusters();
  }

  private drawTrafficStations(): void {
    const ctx = this.context;
    const zoomLevel = this.markerZoomLevel();
    ctx.fillStyle = `rgba(82, 91, 96, ${0.08 + zoomLevel * 0.18})`;
    for (const point of this.traffic) {
      const screen = this.screenPoint(point);
      if (!this.isVisible(screen)) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, (0.8 + zoomLevel * 1.4) * window.devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawClusters(): void {
    const zoomLevel = this.markerZoomLevel();
    const visibleClusters = this.visibleClusterPoints();

    if (this.scale < OVERVIEW_POINT_SCALE) {
      this.drawClusterCloud(visibleClusters, zoomLevel);
    } else {
      this.drawClusterPoints(visibleClusters, zoomLevel, this.localColorScale(visibleClusters));
    }

    this.drawSelectedCluster(zoomLevel);
  }

  private drawClusterCloud(visibleClusters: VisibleClusterPoint[], zoomLevel: number): void {
    const ctx = this.context;
    const radius = Math.max(0.75, 1.15 + zoomLevel * 1.2) * window.devicePixelRatio;

    for (const item of visibleClusters) {
      const intensity = Math.min(1, item.cluster.dangerScore / this.maxDangerScore);
      ctx.fillStyle = colorForIntensity(intensity, 0.22 + intensity * 0.34);
      ctx.beginPath();
      ctx.arc(item.point.x, item.point.y, radius + Math.sqrt(intensity) * window.devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawClusterPoints(visibleClusters: VisibleClusterPoint[], zoomLevel: number, colorScale: number): void {
    const ctx = this.context;

    for (const cluster of visibleClusters) {
      const colorIntensity = Math.min(1, cluster.cluster.dangerScore / colorScale);
      const sizeIntensity = Math.min(1, cluster.cluster.dangerScore / this.maxDangerScore);
      const radius = this.markerRadius(cluster.cluster, sizeIntensity, zoomLevel);
      const alpha = 0.36 + zoomLevel * 0.42;
      ctx.fillStyle = colorForIntensity(colorIntensity, alpha);
      ctx.beginPath();
      ctx.arc(cluster.point.x, cluster.point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSelectedCluster(zoomLevel: number): void {
    if (this.selected) {
      const selected = this.screenPoint(this.selected);
      const ctx = this.context;
      ctx.fillStyle = "rgba(16, 36, 46, 0.18)";
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, (8 + zoomLevel * 9) * window.devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private findClusterAt(screenX: number, screenY: number): IntersectionCluster | null {
    const hitRadius = Math.max(10, 18 * window.devicePixelRatio);
    const candidates: Array<{ cluster: IntersectionCluster; distance: number }> = [];

    for (const cluster of this.projectedClusters) {
      const point = this.screenFromProjected(cluster.projected);
      const distance = Math.hypot(point.x - screenX, point.y - screenY);
      if (distance <= hitRadius) {
        candidates.push({ cluster: cluster.cluster, distance });
      }
    }

    if (candidates.length === 0) {
      this.clickCycle = null;
      return null;
    }

    candidates.sort((a, b) => a.distance - b.distance || b.cluster.dangerScore - a.cluster.dangerScore);
    const clusters = candidates.slice(0, 12).map((candidate) => candidate.cluster);
    const activeCycle = this.clickCycle;
    const canCycle =
      activeCycle !== null &&
      Math.hypot(activeCycle.x - screenX, activeCycle.y - screenY) <= hitRadius &&
      sameClusterSet(activeCycle.candidates, clusters);
    const nextIndex = canCycle ? (activeCycle.index + 1) % clusters.length : 0;
    this.clickCycle = { x: screenX, y: screenY, index: nextIndex, candidates: clusters };
    return clusters[nextIndex];
  }

  private screenPoint(point: { lon: number; lat: number }): ProjectedPoint {
    const projected = project(point.lon, point.lat);
    return this.screenFromProjected(projected);
  }

  private screenFromProjected(projected: ProjectedPoint): ProjectedPoint {
    return {
      x: projected.x * this.scale + this.offsetX,
      y: projected.y * this.scale + this.offsetY
    };
  }

  private scaleAt(screenX: number, screenY: number, factor: number): void {
    const previousScale = this.scale;
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    const actual = this.scale / previousScale;
    this.offsetX = screenX - (screenX - this.offsetX) * actual;
    this.offsetY = screenY - (screenY - this.offsetY) * actual;
    this.requestDraw();
  }

  private centerOn(point: { lon: number; lat: number }): void {
    const projected = project(point.lon, point.lat);
    this.scale = Math.max(this.scale, 4_000_000);
    this.offsetX = this.canvas.width / 2 - projected.x * this.scale;
    this.offsetY = this.canvas.height / 2 - projected.y * this.scale;
  }

  private markerZoomLevel(): number {
    return clamp((Math.log10(this.scale) - 5.05) / 2.0, 0, 1);
  }

  private markerRadius(cluster: IntersectionCluster, intensity: number, zoomLevel: number): number {
    const volume = Math.min(1, Math.log1p(cluster.accidentCount) / Math.log(160));
    const radiusCss = 1.05 + zoomLevel * 3.6 + Math.sqrt(intensity) * (1.2 + zoomLevel * 4.7) + volume * (0.35 + zoomLevel);
    return Math.min(12, radiusCss) * window.devicePixelRatio;
  }

  private visibleClusterPoints(): VisibleClusterPoint[] {
    const visible: VisibleClusterPoint[] = [];

    for (const cluster of this.projectedClusters) {
      const point = this.screenFromProjected(cluster.projected);
      if (this.isVisible(point)) {
        visible.push({ cluster: cluster.cluster, projected: cluster.projected, point });
      }
    }

    return visible;
  }

  private localColorScale(visibleClusters: VisibleClusterPoint[]): number {
    if (visibleClusters.length === 0) {
      return this.maxDangerScore;
    }
    return Math.max(1, ...visibleClusters.map((item) => item.cluster.dangerScore));
  }

  private isVisible(point: ProjectedPoint): boolean {
    const margin = 32 * window.devicePixelRatio;
    return point.x >= -margin && point.x <= this.canvas.width + margin && point.y >= -margin && point.y <= this.canvas.height + margin;
  }

  private resizeToDisplaySize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
    const height = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private requestDraw(): void {
    if (this.drawFrame !== null) {
      return;
    }
    this.drawFrame = window.requestAnimationFrame(() => {
      this.drawFrame = null;
      this.draw();
    });
  }
}

function sameClusterSet(a: IntersectionCluster[], b: IntersectionCluster[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((cluster, index) => cluster.id === b[index].id);
}

function project(lon: number, lat: number): ProjectedPoint {
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

function colorForIntensity(intensity: number, alpha: number): string {
  if (intensity > 0.66) {
    return `rgba(185, 57, 43, ${alpha})`;
  }
  if (intensity > 0.32) {
    return `rgba(210, 133, 40, ${alpha})`;
  }
  return `rgba(34, 134, 141, ${alpha})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
