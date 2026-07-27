import { severityPercentValue } from "./formatting";
import type { IntersectionCluster } from "./types";

const CLUSTER_CSV_HEADER = [
  "state",
  "administrative_region",
  "administrative_region_population",
  "district",
  "municipality",
  "municipality_population",
  "lat",
  "lon",
  "accidents",
  "fatal",
  "serious",
  "osm_roundabout",
  "osm_traffic_signal",
  "severity_percent"
];

export function clustersCsv(clusters: IntersectionCluster[]): string {
  const rows = clusters.map((cluster) =>
    [
      cluster.stateName,
      cluster.administrativeRegionName ?? "",
      cluster.administrativeRegionPopulation ?? "",
      cluster.districtName ?? "",
      cluster.municipalityName ?? "",
      cluster.municipalityPopulation ?? "",
      cluster.lat,
      cluster.lon,
      cluster.accidentCount,
      cluster.fatalCount,
      cluster.seriousCount,
      osmBooleanCsvValue(cluster.osmRoundabout),
      osmBooleanCsvValue(cluster.osmTrafficSignal),
      severityPercentValue(cluster)
    ]
      .map(csvCell)
      .join(",")
  );

  return [CLUSTER_CSV_HEADER.join(","), ...rows].join("\n");
}

function osmBooleanCsvValue(value: boolean | null | undefined): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}
