import { tr } from "../i18n";
import {
  loadOsmTile,
  localMeterOffset,
  maxAbsoluteOffset,
  OSM_TILE_SIZE,
  osmWorldPixel,
  wrapOsmTileX
} from "../osmTiles";
import type { IntersectionCluster } from "../types";

const SELECTED_PREVIEW_MAP_FALLBACK_WIDTH = 640;
const SELECTED_PREVIEW_MAP_FALLBACK_HEIGHT = 360;
const SELECTED_PREVIEW_MAP_MAX_DPR = 2;

export interface SelectedPreviewMapIncidentPoint {
  lat: number;
  lon: number;
  label: string;
}

export interface SelectedPreviewMapViewModel {
  cluster: IntersectionCluster;
  incidentPoints: SelectedPreviewMapIncidentPoint[];
}

export interface SelectedPreviewMapViewDependencies {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  getSelectedClusterId: () => string | null;
  clusterRadiusMeters: () => number;
}

interface SelectedPreviewMapFrame {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

interface SelectedPreviewMapGeometry {
  zoom: number;
  topLeft: { x: number; y: number };
}

export class SelectedPreviewMapView {
  private renderId = 0;

  constructor(private readonly deps: SelectedPreviewMapViewDependencies) {}

  clear(): void {
    this.renderId += 1;
    this.deps.container.hidden = true;
    const context = this.deps.canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.deps.canvas.width, this.deps.canvas.height);
  }

  render(viewModel: SelectedPreviewMapViewModel): void {
    const context = this.deps.canvas.getContext("2d");
    if (!context) {
      return;
    }

    this.deps.container.hidden = false;
    const renderId = ++this.renderId;
    const frame = this.resizeCanvas();
    const geometry = this.mapGeometry(viewModel.cluster, viewModel.incidentPoints, frame);
    context.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
    this.drawBackground(context, frame);
    this.drawMarkers(context, viewModel, geometry, frame);
    this.drawAttribution(context, frame);
    void this.drawOsmTiles(viewModel, frame, renderId);
  }

  private resizeCanvas(): SelectedPreviewMapFrame {
    const canvas = this.deps.canvas;
    const rect = canvas.getBoundingClientRect();
    const measuredWidth = Math.round(rect.width);
    const measuredHeight = Math.round(rect.height);
    const cssWidth = measuredWidth > 0 ? measuredWidth : SELECTED_PREVIEW_MAP_FALLBACK_WIDTH;
    const cssHeight =
      measuredHeight > 0
        ? measuredHeight
        : Math.round((cssWidth / SELECTED_PREVIEW_MAP_FALLBACK_WIDTH) * SELECTED_PREVIEW_MAP_FALLBACK_HEIGHT);
    const dpr = Math.min(SELECTED_PREVIEW_MAP_MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    return { cssWidth, cssHeight, dpr };
  }

  private drawBackground(context: CanvasRenderingContext2D, frame: SelectedPreviewMapFrame): void {
    context.clearRect(0, 0, frame.cssWidth, frame.cssHeight);
    context.fillStyle = "#eef2ef";
    context.fillRect(0, 0, frame.cssWidth, frame.cssHeight);
    context.strokeStyle = "rgba(83, 99, 109, 0.12)";
    context.lineWidth = 1;
    for (let x = 32; x < frame.cssWidth; x += 48) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, frame.cssHeight);
      context.stroke();
    }
    for (let y = 32; y < frame.cssHeight; y += 48) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(frame.cssWidth, y);
      context.stroke();
    }
  }

  private async drawOsmTiles(
    viewModel: SelectedPreviewMapViewModel,
    frame: SelectedPreviewMapFrame,
    renderId: number
  ): Promise<void> {
    const geometry = this.mapGeometry(viewModel.cluster, viewModel.incidentPoints, frame);
    const tileCount = 2 ** geometry.zoom;
    const startTileX = Math.floor(geometry.topLeft.x / OSM_TILE_SIZE);
    const endTileX = Math.floor((geometry.topLeft.x + frame.cssWidth) / OSM_TILE_SIZE);
    const startTileY = Math.max(0, Math.floor(geometry.topLeft.y / OSM_TILE_SIZE));
    const endTileY = Math.min(tileCount - 1, Math.floor((geometry.topLeft.y + frame.cssHeight) / OSM_TILE_SIZE));
    const tileJobs: Array<Promise<{ tileX: number; tileY: number; image: HTMLImageElement | null }>> = [];

    for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
      for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
        const wrappedX = wrapOsmTileX(tileX, tileCount);
        tileJobs.push(loadOsmTile(geometry.zoom, wrappedX, tileY).then((image) => ({ tileX, tileY, image })));
      }
    }

    const tiles = await Promise.all(tileJobs);
    if (renderId !== this.renderId || this.deps.getSelectedClusterId() !== viewModel.cluster.id || this.deps.container.hidden) {
      return;
    }

    const context = this.deps.canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
    this.drawBackground(context, frame);
    context.save();
    context.filter = "grayscale(1) saturate(0) contrast(0.68) brightness(1.14)";
    context.globalAlpha = 0.72;
    for (const { tileX, tileY, image } of tiles) {
      if (!image) {
        continue;
      }
      const drawX = tileX * OSM_TILE_SIZE - geometry.topLeft.x;
      const drawY = tileY * OSM_TILE_SIZE - geometry.topLeft.y;
      context.drawImage(image, drawX, drawY, OSM_TILE_SIZE, OSM_TILE_SIZE);
    }
    context.restore();
    this.drawMarkers(context, viewModel, geometry, frame);
    this.drawAttribution(context, frame);
  }

  private mapGeometry(
    cluster: IntersectionCluster,
    incidentPoints: SelectedPreviewMapIncidentPoint[],
    frame: SelectedPreviewMapFrame
  ): SelectedPreviewMapGeometry {
    const zoom = this.chooseMapZoom(cluster, incidentPoints, frame.cssWidth, frame.cssHeight);
    const center = osmWorldPixel(cluster.lon, cluster.lat, zoom);
    return {
      zoom,
      topLeft: {
        x: center.x - frame.cssWidth / 2,
        y: center.y - frame.cssHeight / 2
      }
    };
  }

  private chooseMapZoom(
    cluster: IntersectionCluster,
    incidentPoints: SelectedPreviewMapIncidentPoint[],
    width: number,
    height: number
  ): number {
    const offsets = incidentPoints.map((point) => localMeterOffset(cluster, point));
    const baseRadiusMeters = Math.max(55, this.deps.clusterRadiusMeters());
    const radiusMeters = maxAbsoluteOffset(baseRadiusMeters, offsets) + 24;
    const usableWidth = Math.max(120, width - 36);
    const usableHeight = Math.max(80, height - 36);

    for (let zoom = 19; zoom >= 10; zoom -= 1) {
      const metersPerPixel = (156_543.03392 * Math.cos(radians(cluster.lat))) / 2 ** zoom;
      if (usableWidth * metersPerPixel >= radiusMeters * 2 && usableHeight * metersPerPixel >= radiusMeters * 2) {
        return Math.min(19, zoom + 1);
      }
    }
    return 10;
  }

  private drawMarkers(
    context: CanvasRenderingContext2D,
    viewModel: SelectedPreviewMapViewModel,
    geometry: SelectedPreviewMapGeometry,
    frame: SelectedPreviewMapFrame
  ): void {
    const { cluster, incidentPoints } = viewModel;
    const center = this.screenPoint(cluster, geometry);
    context.save();
    context.fillStyle = "rgba(16, 36, 46, 0.18)";
    context.beginPath();
    context.arc(center.x, center.y, 30, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#166b6d";
    context.beginPath();
    context.arc(center.x, center.y, 8, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 3;
    context.stroke();

    context.font = '700 12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const incident of incidentPoints) {
      const point = this.screenPoint(incident, geometry);
      if (point.x < -24 || point.x > frame.cssWidth + 24 || point.y < -24 || point.y > frame.cssHeight + 24) {
        continue;
      }
      const radius = Math.max(10, context.measureText(incident.label).width / 2 + 5);
      context.fillStyle = "rgba(255, 255, 255, 0.9)";
      context.strokeStyle = "rgba(255, 255, 255, 0.95)";
      context.lineWidth = 3;
      context.beginPath();
      context.arc(point.x, point.y, radius + 1.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = "#050505";
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#ffffff";
      context.fillText(incident.label, point.x, point.y + 0.3);
    }
    context.restore();
  }

  private screenPoint(point: { lon: number; lat: number }, geometry: SelectedPreviewMapGeometry): { x: number; y: number } {
    const worldPoint = osmWorldPixel(point.lon, point.lat, geometry.zoom);
    return {
      x: worldPoint.x - geometry.topLeft.x,
      y: worldPoint.y - geometry.topLeft.y
    };
  }

  private drawAttribution(context: CanvasRenderingContext2D, frame: SelectedPreviewMapFrame): void {
    const label = tr("factsheet.mapAttribution");
    context.save();
    context.font = '600 10px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const width = context.measureText(label).width + 12;
    const height = 18;
    context.fillStyle = "rgba(255, 255, 255, 0.9)";
    context.fillRect(7, frame.cssHeight - height - 7, width, height);
    context.fillStyle = "#1d2d34";
    context.fillText(label, 13, frame.cssHeight - 13);
    context.restore();
  }
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
