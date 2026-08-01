export const STATE_NAMES: Record<string, string> = {
  "01": "Schleswig-Holstein",
  "02": "Hamburg",
  "03": "Niedersachsen",
  "04": "Bremen",
  "05": "Nordrhein-Westfalen",
  "06": "Hessen",
  "07": "Rheinland-Pfalz",
  "08": "Baden-Wuerttemberg",
  "09": "Bayern",
  "10": "Saarland",
  "11": "Berlin",
  "12": "Brandenburg",
  "13": "Mecklenburg-Vorpommern",
  "14": "Sachsen",
  "15": "Sachsen-Anhalt",
  "16": "Thueringen"
};

export function normalizeStateCode(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "00";
  }
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric)) {
    return String(numeric).padStart(2, "0");
  }
  return raw.padStart(2, "0").slice(-2);
}

export function stateNameFor(code: string): string {
  return STATE_NAMES[code] ?? `Bundesland ${code || "unknown"}`;
}
