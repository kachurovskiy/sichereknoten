import { IntersectionCluster } from "./types";

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

interface UserLocation {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
}

interface SeverityFilters {
  fatal: boolean;
  serious: boolean;
  other: boolean;
}

type ClusterSeverity = keyof SeverityFilters;

type SelectionReason = "auto" | "program" | "user";
type SelectionCallback = (cluster: IntersectionCluster | null, reason: SelectionReason) => void;

const MIN_SCALE = 250;
const MAX_SCALE = 80_000_000;
const CLICK_TOLERANCE_PX = 8;
const OSM_TILE_SIZE = 256;
const OSM_MIN_ZOOM = 0;
const OSM_MAX_ZOOM = 19;
const OSM_MAX_CACHED_TILES = 512;
const OSM_TILE_FILTER = "grayscale(1) saturate(0) contrast(0.62) brightness(1.18)";
const OSM_TILE_ALPHA = 0.58;

interface VisualScale {
  metricScale: number;
  zoomLevel: number;
}

interface TileRecord {
  image: HTMLImageElement;
  state: "loading" | "loaded" | "error";
  lastUsed: number;
}

export class MapCanvas {
  private readonly context: CanvasRenderingContext2D;
  private clusters: IntersectionCluster[] = [];
  private projectedClusters: ProjectedCluster[] = [];
  private selected: IntersectionCluster | null = null;
  private userLocation: UserLocation | null = null;
  private maxFatalPercent = 0.01;
  private severityFilters: SeverityFilters = { fatal: true, serious: true, other: false };
  private tileCache = new Map<string, TileRecord>();
  private tileUseCounter = 0;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private bounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  private dragging = false;
  private lastPointer: ProjectedPoint | null = null;
  private pointerDown: ProjectedPoint | null = null;
  private readonly activePointers = new Map<number, ProjectedPoint>();
  private primaryPointerId: number | null = null;
  private pinchDistance: number | null = null;
  private pinchCenter: ProjectedPoint | null = null;
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

  setData(clusters: IntersectionCluster[]): void {
    this.clusters = clusters;
    this.maxFatalPercent = Math.max(0.01, ...clusters.map((cluster) => cluster.fatalPercent));
    this.projectedClusters = clusters
      .map((cluster) => ({ cluster, projected: project(cluster.lon, cluster.lat) }))
      .sort((a, b) => drawPriority(a.cluster) - drawPriority(b.cluster));
    this.selected = null;
    this.fit();
    this.draw();
    this.onSelect(null, "auto");
  }

  setSeverityFilters(filters: SeverityFilters): void {
    this.severityFilters = filters;
    if (this.selected && !this.shouldShowCluster(this.selected)) {
      this.selected = null;
      this.onSelect(null, "auto");
    }
    this.draw();
  }

  select(cluster: IntersectionCluster | null, focus = false, reason: SelectionReason = "program"): void {
    this.selected = cluster;
    if (cluster && focus) {
      this.centerOn(cluster);
    }
    this.draw();
    this.onSelect(cluster, reason);
  }

  setUserLocation(location: UserLocation, focus = true): void {
    this.userLocation = location;
    if (focus) {
      this.centerOn(location);
    }
    this.draw();
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

  refresh(): void {
    this.draw();
  }

  private attachEvents(): void {
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.32 : 0.76;
      this.scaleAt(event.offsetX * window.devicePixelRatio, event.offsetY * window.devicePixelRatio, factor);
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const pointer = { x: event.clientX, y: event.clientY };
      this.activePointers.set(event.pointerId, pointer);
      this.canvas.setPointerCapture(event.pointerId);

      if (this.activePointers.size === 1) {
        this.dragging = true;
        this.primaryPointerId = event.pointerId;
        this.lastPointer = pointer;
        this.pointerDown = pointer;
        this.pinchDistance = null;
        this.pinchCenter = null;
      } else if (this.activePointers.size === 2) {
        this.pointerDown = null;
        this.initializePinch();
      }
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.activePointers.has(event.pointerId)) {
        return;
      }
      event.preventDefault();
      const pointer = { x: event.clientX, y: event.clientY };
      this.activePointers.set(event.pointerId, pointer);

      if (this.activePointers.size >= 2) {
        this.handlePinch();
        return;
      }

      if (!this.dragging || !this.lastPointer || this.primaryPointerId !== event.pointerId) {
        return;
      }

      const dx = (pointer.x - this.lastPointer.x) * window.devicePixelRatio;
      const dy = (pointer.y - this.lastPointer.y) * window.devicePixelRatio;
      this.offsetX += dx;
      this.offsetY += dy;
      this.lastPointer = pointer;
      this.requestDraw();
    });

    this.canvas.addEventListener("pointerup", (event) => {
      this.endPointer(event, true);
    });

    this.canvas.addEventListener("pointercancel", (event) => {
      this.endPointer(event, false);
    });
  }

  private endPointer(event: PointerEvent, selectOnTap: boolean): void {
    if (!this.activePointers.has(event.pointerId)) {
      return;
    }

    event.preventDefault();
    const pointer = { x: event.clientX, y: event.clientY };
    const wasSinglePointer = this.activePointers.size === 1 && this.primaryPointerId === event.pointerId;
    const pointerMoved = this.pointerDown ? Math.hypot(pointer.x - this.pointerDown.x, pointer.y - this.pointerDown.y) > CLICK_TOLERANCE_PX : true;

    this.activePointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (selectOnTap && wasSinglePointer && !pointerMoved) {
      const canvasPoint = this.canvasPointFromClient(pointer);
      const cluster = this.findClusterAt(canvasPoint.x, canvasPoint.y);
      if (cluster) {
        this.select(cluster, false, "user");
      }
    }

    if (this.activePointers.size === 0) {
      this.resetPointerState();
      return;
    }

    if (this.activePointers.size === 1) {
      const remaining = this.activePointers.entries().next().value;
      if (!remaining) {
        this.resetPointerState();
        return;
      }
      this.primaryPointerId = remaining[0];
      this.lastPointer = remaining[1];
      this.pointerDown = null;
      this.dragging = true;
      this.pinchDistance = null;
      this.pinchCenter = null;
      return;
    }

    this.initializePinch();
  }

  private initializePinch(): void {
    const points = this.pointerList();
    if (points.length < 2) {
      this.pinchDistance = null;
      this.pinchCenter = null;
      return;
    }

    this.dragging = false;
    this.lastPointer = null;
    this.pointerDown = null;
    this.pinchDistance = pointerDistance(points[0], points[1]);
    this.pinchCenter = pointerCenter(points[0], points[1]);
  }

  private handlePinch(): void {
    const points = this.pointerList();
    if (points.length < 2) {
      return;
    }

    const distance = pointerDistance(points[0], points[1]);
    const center = pointerCenter(points[0], points[1]);
    if (this.pinchDistance !== null && this.pinchCenter) {
      const centerCanvas = this.canvasPointFromClient(center);
      const previousCenterCanvas = this.canvasPointFromClient(this.pinchCenter);
      this.offsetX += centerCanvas.x - previousCenterCanvas.x;
      this.offsetY += centerCanvas.y - previousCenterCanvas.y;
      if (distance > 0 && this.pinchDistance > 0) {
        this.scaleAt(centerCanvas.x, centerCanvas.y, distance / this.pinchDistance);
      } else {
        this.requestDraw();
      }
    }

    this.pinchDistance = distance;
    this.pinchCenter = center;
  }

  private pointerList(): ProjectedPoint[] {
    return Array.from(this.activePointers.values());
  }

  private canvasPointFromClient(point: ProjectedPoint): ProjectedPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((point.x - rect.left) / Math.max(rect.width, 1)) * this.canvas.width,
      y: ((point.y - rect.top) / Math.max(rect.height, 1)) * this.canvas.height
    };
  }

  private resetPointerState(): void {
    this.dragging = false;
    this.lastPointer = null;
    this.pointerDown = null;
    this.primaryPointerId = null;
    this.pinchDistance = null;
    this.pinchCenter = null;
  }

  private fit(): void {
    const projected = this.projectedClusters.filter((point) => this.shouldShowCluster(point.cluster)).map((point) => point.projected);

    if (projected.length === 0) {
      this.bounds = null;
      if (this.userLocation) {
        this.scale = 4_000_000;
        this.centerOn(this.userLocation);
      } else {
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
      }
      return;
    }

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

    if (this.bounds || this.userLocation) {
      this.drawBasemap();
    }

    if (this.bounds && this.clusters.length > 0) {
      this.drawClusters();
    }

    this.drawUserLocation();
  }

  private drawBasemap(): void {
    const zoom = this.tileZoom();
    const tileCount = 2 ** zoom;
    const tileSize = this.scale / tileCount;
    if (!Number.isFinite(tileSize) || tileSize <= 0) {
      return;
    }

    const startX = Math.floor(-this.offsetX / tileSize) - 1;
    const endX = Math.ceil((this.canvas.width - this.offsetX) / tileSize) + 1;
    const startY = Math.max(0, Math.floor(-this.offsetY / tileSize) - 1);
    const endY = Math.min(tileCount - 1, Math.ceil((this.canvas.height - this.offsetY) / tileSize) + 1);

    const ctx = this.context;
    ctx.save();
    ctx.filter = OSM_TILE_FILTER;
    ctx.globalAlpha = OSM_TILE_ALPHA;

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const tile = this.tileRecord(zoom, wrapTileX(x, tileCount), y);
        tile.lastUsed = ++this.tileUseCounter;
        if (tile.state !== "loaded") {
          continue;
        }

        const screenX = Math.round(x * tileSize + this.offsetX);
        const screenY = Math.round(y * tileSize + this.offsetY);
        const drawSize = Math.ceil(tileSize) + 1;
        ctx.drawImage(tile.image, screenX, screenY, drawSize, drawSize);
      }
    }

    ctx.restore();
    this.pruneTileCache();
  }

  private tileZoom(): number {
    return Math.round(clamp(Math.log2(this.scale / OSM_TILE_SIZE), OSM_MIN_ZOOM, OSM_MAX_ZOOM));
  }

  private tileRecord(zoom: number, x: number, y: number): TileRecord {
    const key = `${zoom}/${x}/${y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      return cached;
    }

    const image = new Image();
    const record: TileRecord = { image, state: "loading", lastUsed: ++this.tileUseCounter };
    image.decoding = "async";
    image.referrerPolicy = "strict-origin-when-cross-origin";
    image.onload = () => {
      record.state = "loaded";
      this.requestDraw();
    };
    image.onerror = () => {
      record.state = "error";
    };
    image.src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
    this.tileCache.set(key, record);
    return record;
  }

  private pruneTileCache(): void {
    if (this.tileCache.size <= OSM_MAX_CACHED_TILES) {
      return;
    }

    const entries = Array.from(this.tileCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const deleteCount = this.tileCache.size - OSM_MAX_CACHED_TILES;
    for (const [key] of entries.slice(0, deleteCount)) {
      this.tileCache.delete(key);
    }
  }

  private drawClusters(): void {
    const zoomLevel = this.markerZoomLevel();
    const visibleClusters = this.visibleClusterPoints();
    const visualScale = this.visualScale(visibleClusters, zoomLevel);

    this.drawClusterPoints(visibleClusters, visualScale);
    this.drawSelectedCluster(zoomLevel);
  }

  private drawClusterPoints(visibleClusters: VisibleClusterPoint[], visualScale: VisualScale): void {
    const ctx = this.context;

    for (const cluster of visibleClusters) {
      const metricIntensity = Math.min(1, cluster.cluster.fatalPercent / visualScale.metricScale);
      const radius = this.markerRadius(cluster.cluster, metricIntensity, visualScale.zoomLevel);
      const alpha = this.markerAlpha(cluster.cluster, metricIntensity, visualScale.zoomLevel);
      ctx.fillStyle = colorForIntensity(metricIntensity, alpha);
      ctx.beginPath();
      ctx.arc(cluster.point.x, cluster.point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSelectedCluster(zoomLevel: number): void {
    if (this.selected && this.shouldShowCluster(this.selected)) {
      const selected = this.screenPoint(this.selected);
      const ctx = this.context;
      ctx.fillStyle = "rgba(16, 36, 46, 0.18)";
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, (8 + zoomLevel * 9) * window.devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawUserLocation(): void {
    if (!this.userLocation) {
      return;
    }

    const point = this.screenPoint(this.userLocation);
    if (!this.isVisible(point)) {
      return;
    }

    const ctx = this.context;
    const accuracyRadius = this.accuracyRadiusPx(this.userLocation);
    if (accuracyRadius <= 0) {
      return;
    }

    ctx.fillStyle = "rgba(22, 107, 109, 0.12)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, accuracyRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  private findClusterAt(screenX: number, screenY: number): IntersectionCluster | null {
    const hitRadius = Math.max(10, 18 * window.devicePixelRatio);
    const candidates: Array<{ cluster: IntersectionCluster; distance: number }> = [];

    for (const cluster of this.projectedClusters) {
      if (!this.shouldShowCluster(cluster.cluster)) {
        continue;
      }
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

    candidates.sort((a, b) => a.distance - b.distance || compareFatalMetric(a.cluster, b.cluster));
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

  private accuracyRadiusPx(location: UserLocation): number {
    if (!location.accuracyMeters || !Number.isFinite(location.accuracyMeters) || location.accuracyMeters <= 0) {
      return 0;
    }

    const latitudeFactor = Math.max(0.08, Math.cos((location.lat * Math.PI) / 180));
    const deltaLon = (location.accuracyMeters / (40_075_016.686 * latitudeFactor)) * 360;
    const center = project(location.lon, location.lat);
    const edge = project(location.lon + deltaLon, location.lat);
    return Math.abs(edge.x - center.x) * this.scale;
  }

  private markerZoomLevel(): number {
    return clamp((Math.log10(this.scale) - 5.05) / 2.0, 0, 1);
  }

  private markerRadius(cluster: IntersectionCluster, metricIntensity: number, zoomLevel: number): number {
    const volume = Math.min(1, Math.log1p(cluster.accidentCount) / Math.log(160));
    const radiusCss =
      lerp(0.75, 2.4, zoomLevel) +
      Math.sqrt(metricIntensity) * lerp(1.25, 5.4, zoomLevel) +
      volume * lerp(0.25, 1.45, zoomLevel);
    return Math.min(14, radiusCss) * window.devicePixelRatio;
  }

  private markerAlpha(cluster: IntersectionCluster, metricIntensity: number, zoomLevel: number): number {
    const confidence = 1 - Math.exp(-cluster.accidentCount / 6);
    const baseAlpha = lerp(0.14, 0.24, zoomLevel);
    const metricAlpha = Math.sqrt(metricIntensity) * lerp(0.24, 0.42, zoomLevel);
    const fatalAlpha = cluster.fatalCount > 0 ? 0.08 : 0;
    return clamp(baseAlpha + confidence * metricAlpha + fatalAlpha, 0.14, 0.86);
  }

  private visibleClusterPoints(): VisibleClusterPoint[] {
    const visible: VisibleClusterPoint[] = [];

    for (const cluster of this.projectedClusters) {
      if (!this.shouldShowCluster(cluster.cluster)) {
        continue;
      }
      const point = this.screenFromProjected(cluster.projected);
      if (this.isVisible(point)) {
        visible.push({ cluster: cluster.cluster, projected: cluster.projected, point });
      }
    }

    return visible;
  }

  private shouldShowCluster(cluster: IntersectionCluster): boolean {
    return this.severityFilters[clusterSeverity(cluster)];
  }

  private visualScale(visibleClusters: VisibleClusterPoint[], zoomLevel: number): VisualScale {
    const localMetricScale = this.localMetricScale(visibleClusters);
    const localWeight = smoothstep(zoomLevel);
    return {
      metricScale: Math.max(0.01, lerp(this.maxFatalPercent, localMetricScale, localWeight)),
      zoomLevel
    };
  }

  private localMetricScale(visibleClusters: VisibleClusterPoint[]): number {
    if (visibleClusters.length === 0) {
      return this.maxFatalPercent;
    }
    return Math.max(0.01, ...visibleClusters.map((item) => item.cluster.fatalPercent));
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

function pointerDistance(a: ProjectedPoint, b: ProjectedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCenter(a: ProjectedPoint, b: ProjectedPoint): ProjectedPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function drawPriority(cluster: IntersectionCluster): number {
  return cluster.fatalPercent + Math.min(10, cluster.accidentCount) * 0.001;
}

function compareFatalMetric(a: IntersectionCluster, b: IntersectionCluster): number {
  return (
    b.fatalPercent - a.fatalPercent ||
    b.fatalCount - a.fatalCount ||
    b.seriousCount - a.seriousCount ||
    b.accidentCount - a.accidentCount
  );
}

function clusterSeverity(cluster: IntersectionCluster): ClusterSeverity {
  if (cluster.fatalCount > 0) {
    return "fatal";
  }
  if (cluster.seriousCount > 0) {
    return "serious";
  }
  return "other";
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

function wrapTileX(x: number, tileCount: number): number {
  return ((x % tileCount) + tileCount) % tileCount;
}

function lerp(a: number, b: number, weight: number): number {
  return a + (b - a) * weight;
}

function smoothstep(value: number): number {
  const clamped = clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
