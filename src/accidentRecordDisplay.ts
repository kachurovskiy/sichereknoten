import { formatAccidentStreetNames } from "./clusterDisplay";
import { formatInteger, formatNumber } from "./formatting";
import { tr, trf } from "./i18n";
import { ROAD_USER_DEFINITIONS } from "./roadUsers";
import type { AccidentRecord } from "./types";

export type AccidentSeverity = "fatal" | "serious" | "other";

export interface AccidentRecordRow {
  label: string;
  value: string;
}

const ACCIDENT_CATEGORY_LABELS: Record<number, string> = {
  1: "accident.category.killed",
  2: "accident.category.seriouslyInjured",
  3: "accident.category.slightlyInjured"
};
const ACCIDENT_KIND_LABELS: Record<number, string> = {
  0: "accident.kind.other",
  1: "accident.kind.startsStopsStationary",
  2: "accident.kind.movingAheadWaiting",
  3: "accident.kind.lateralSameDirection",
  4: "accident.kind.oncoming",
  5: "accident.kind.turnsOrCrosses",
  6: "accident.kind.pedestrian",
  7: "accident.kind.obstacle",
  8: "accident.kind.leavingRight",
  9: "accident.kind.leavingLeft"
};
const ACCIDENT_TYPE_LABELS: Record<number, string> = {
  1: "accident.type.driving",
  2: "accident.type.turningOff",
  3: "accident.type.turningIntoCrossing",
  4: "accident.type.crossingRoad",
  5: "accident.type.stationaryTraffic",
  6: "accident.type.sameCarriageway",
  7: "accident.type.other"
};
const LIGHT_CONDITION_LABELS: Record<number, string> = {
  0: "accident.light.daylight",
  1: "accident.light.twilight",
  2: "accident.light.darkness"
};
const ROAD_SURFACE_LABELS: Record<number, string> = {
  0: "accident.surface.dry",
  1: "accident.surface.wet",
  2: "accident.surface.winter"
};
const PLAUSIBILITY_LEVEL_LABELS: Record<number, string> = {
  1: "accident.plausibility.regular",
  2: "accident.plausibility.bicycle"
};

export function accidentRecordRows(
  accident: AccidentRecord,
  distanceMeters: number | null,
  streetOrder: string[] = []
): AccidentRecordRow[] {
  const rows: AccidentRecordRow[] = [];
  addRecordRow(rows, tr("records.category"), codeLabel(accident.category, ACCIDENT_CATEGORY_LABELS));
  addRecordRow(rows, tr("records.kind"), codeLabel(accident.accidentKind, ACCIDENT_KIND_LABELS));
  addRecordRow(rows, tr("records.type"), codeLabel(accident.accidentType, ACCIDENT_TYPE_LABELS));
  addRecordRow(rows, tr("records.light"), codeLabel(accident.lightCondition, LIGHT_CONDITION_LABELS));
  addRecordRow(rows, tr("records.surface"), codeLabel(accident.roadSurface, ROAD_SURFACE_LABELS));
  addRecordRow(rows, tr("records.street"), formatAccidentStreetNames(accident, streetOrder));
  addRecordRow(rows, tr("records.roadUsers"), roadUsersLabel(accident));
  addRecordRow(rows, tr("records.area"), administrativeAreaLabel(accident));
  addRecordRow(rows, tr("records.coordinates"), `${accident.lat.toFixed(6)}, ${accident.lon.toFixed(6)}`);
  addRecordRow(rows, "LINREF", linRefLabel(accident));
  addRecordRow(rows, tr("records.locationCheck"), codeLabel(accident.plausibilityLevel, PLAUSIBILITY_LEVEL_LABELS));
  addRecordRow(rows, tr("records.distance"), distanceMeters === null ? null : `${formatInteger(Math.round(distanceMeters))} m`);
  addRecordRow(rows, tr("records.recordId"), recordIdLabel(accident));
  addRecordRow(rows, tr("records.source"), accident.source);
  return rows;
}

export function accidentSeverity(accident: AccidentRecord): AccidentSeverity {
  if (accident.category === 1) {
    return "fatal";
  }
  if (accident.category === 2) {
    return "serious";
  }
  return "other";
}

export function accidentSeverityLabel(accident: AccidentRecord): string {
  if (accident.category === 1) {
    return tr("severity.fatal");
  }
  if (accident.category === 2) {
    return tr("severity.serious");
  }
  if (accident.category === 3) {
    return tr("severity.light");
  }
  return accident.category === null ? tr("severity.unknown") : trf("records.categoryNumber", { category: accident.category });
}

export function accidentTimeLabel(accident: AccidentRecord): string {
  const parts = [accident.year ? String(accident.year) : tr("records.unknownYear")];
  if (accident.month) {
    parts.push(
      accident.day
        ? `${monthLabel(accident.month)} ${formatInteger(accident.day)}`
        : `${monthLabel(accident.month)} (${tr("records.dayNotProvided")})`
    );
  }
  if (accident.weekday) {
    parts.push(weekdayLabel(accident.weekday));
  }
  if (accident.hour !== null) {
    parts.push(`${String(accident.hour).padStart(2, "0")}:00`);
  }
  return parts.join(", ");
}

export function accidentKey(accident: AccidentRecord): string {
  return `${accident.source}\0${accident.id}`;
}

function addRecordRow(rows: AccidentRecordRow[], label: string, value: string | null): void {
  if (value) {
    rows.push({ label, value });
  }
}

function monthLabel(month: number): string {
  return tr(`month.${month}`);
}

function weekdayLabel(weekday: number): string {
  return tr(`weekday.${weekday}`);
}

function codeLabel(value: number | null | undefined, labels: Record<number, string>): string | null {
  if (typeof value !== "number") {
    return null;
  }
  return `${value} - ${labels[value] ? tr(labels[value]) : tr("records.unknownCode")}`;
}

function roadUsersLabel(accident: AccidentRecord): string {
  const flags: Array<[string, boolean | null]> = ROAD_USER_DEFINITIONS.map((definition) => [
    tr(definition.labelKey),
    definition.read(accident)
  ]);
  const knownFlags = flags.filter((entry): entry is [string, boolean] => entry[1] !== null);
  if (knownFlags.length === 0) {
    return tr("records.noRoadUserFields");
  }
  const involved = knownFlags.filter(([, value]) => value).map(([label]) => label);
  return involved.length > 0 ? involved.join(", ") : tr("records.noRoadUsersInvolved");
}

function administrativeAreaLabel(accident: AccidentRecord): string {
  const parts = [`${accident.stateName} (${accident.stateCode})`];
  if (accident.administrativeRegionCode) {
    parts.push(
      namedCodeLabel(accident.administrativeRegionName, accident.administrativeRegionCode) ??
        trf("records.adminRegion", { code: accident.administrativeRegionCode })
    );
  }
  if (accident.districtCode) {
    parts.push(namedCodeLabel(accident.districtName, accident.districtCode) ?? trf("records.district", { code: accident.districtCode }));
  }
  if (accident.municipalityCode) {
    const municipalityLabel = namedCodeLabel(accident.municipalityName, accident.municipalityCode);
    if (municipalityLabel && accident.municipalityName !== accident.districtName) {
      parts.push(municipalityLabel);
    } else if (!municipalityLabel && !hasEquivalentDistrictMunicipalityCode(accident)) {
      parts.push(trf("records.municipality", { code: accident.municipalityCode }));
    }
  }
  return parts.join(", ");
}

function namedCodeLabel(name: string | null, code: string | null): string | null {
  return name && code ? `${name} (${code})` : null;
}

function hasEquivalentDistrictMunicipalityCode(accident: AccidentRecord): boolean {
  return Boolean(
    accident.districtName &&
      accident.districtCode &&
      accident.municipalityCode &&
      normalizeCodePart(accident.municipalityCode, 3).endsWith(normalizeCodePart(accident.districtCode, 2))
  );
}

function normalizeCodePart(value: string, width: number): string {
  return value.trim().replace(/\D/g, "").padStart(width, "0").slice(-width);
}

function linRefLabel(accident: AccidentRecord): string | null {
  if (typeof accident.linRefX !== "number" || typeof accident.linRefY !== "number") {
    return null;
  }
  return `${formatNumber(accident.linRefX)}, ${formatNumber(accident.linRefY)} (EPSG:25832)`;
}

function recordIdLabel(accident: AccidentRecord): string {
  const parts = [accident.id];
  if (accident.serialNumber && accident.serialNumber !== accident.id) {
    parts.push(trf("records.serial", { serial: accident.serialNumber }));
  }
  return parts.join(", ");
}
