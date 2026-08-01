import { AccidentRecord, RoadUserKey } from "./types";

export interface RoadUserDefinition {
  key: RoadUserKey;
  labelKey: string;
  read: (accident: AccidentRecord) => boolean | null;
}

export const ROAD_USER_DEFINITIONS: RoadUserDefinition[] = [
  { key: "car", labelKey: "roadUser.car", read: (accident) => accident.involvesCar },
  { key: "pedestrian", labelKey: "roadUser.pedestrian", read: (accident) => accident.involvesPedestrian },
  { key: "bicycle", labelKey: "roadUser.bicycle", read: (accident) => accident.involvesBike },
  { key: "motorcycle", labelKey: "roadUser.motorcycle", read: (accident) => accident.involvesMotorcycle },
  { key: "truck", labelKey: "roadUser.truck", read: (accident) => accident.involvesTruck },
  { key: "other", labelKey: "roadUser.other", read: (accident) => accident.involvesOther }
];

export function accidentMatchesRoadUserFocus(accident: AccidentRecord, focus: Set<RoadUserKey>): boolean {
  if (focus.size === 0) {
    return true;
  }
  return ROAD_USER_DEFINITIONS.some((definition) => focus.has(definition.key) && definition.read(accident) === true);
}

export function roadUserFocusKey(focus: Set<RoadUserKey>): string {
  return ROAD_USER_DEFINITIONS.filter((definition) => focus.has(definition.key))
    .map((definition) => definition.key)
    .join(",");
}
