import { tr } from "../shared/i18n";
import { clampNumber, round } from "../shared/math";
import { ROAD_USER_DEFINITIONS } from "../domain/roadUsers";
import { STATE_NAMES } from "../domain/states";
import type { AnalysisOptions, RoadUserKey, SeverityPercentOptions } from "../domain/types";

export { analysisOptionsEqual, cloneAnalysisOptions } from "./analysisOptions";

export interface AnalysisOptionsFormElements {
  analyzeButton: HTMLButtonElement;
  clusterRadius: HTMLInputElement;
  clusterRadiusOut: HTMLInputElement;
  minAccidents: HTMLInputElement;
  fatalWeight: HTMLInputElement;
  seriousWeight: HTMLInputElement;
  severityFullSample: HTMLInputElement;
  severityTrendYears: HTMLInputElement;
  severityTrendDeadZone: HTMLInputElement;
  severityTrendFullSignal: HTMLInputElement;
  severityMaxTrendAdjustment: HTMLInputElement;
  severityMaxPercent: HTMLInputElement;
  stateFilter: HTMLSelectElement;
  roadUserFocus: HTMLElement;
  yearFilter: HTMLElement;
}

export interface AnalysisOptionsFormDependencies {
  onDraftChange: () => void;
}

export class AnalysisOptionsForm {
  private dirty = false;

  constructor(
    private readonly elements: AnalysisOptionsFormElements,
    private readonly deps: AnalysisOptionsFormDependencies
  ) {}

  bindEvents(): void {
    this.wireLinkedNumberRange(this.elements.clusterRadius, this.elements.clusterRadiusOut);

    this.wireClampedNumberInput(this.elements.minAccidents);
    this.wireClampedNumberInput(this.elements.severityFullSample);
    this.wireClampedNumberInput(this.elements.severityTrendYears);
    this.severityPercentDecimalInputs().forEach((input) => this.wireClampedDecimalInput(input));

    this.elements.stateFilter.addEventListener("input", this.deps.onDraftChange);
    this.elements.stateFilter.addEventListener("change", this.deps.onDraftChange);
    this.roadUserFocusInputs().forEach((input) => input.addEventListener("change", this.deps.onDraftChange));
  }

  resetToDefaults(): void {
    this.resetInputToDefault(this.elements.clusterRadius);
    this.resetInputToDefault(this.elements.clusterRadiusOut);
    this.resetInputToDefault(this.elements.minAccidents);
    this.severityPercentInputs().forEach((input) => this.resetInputToDefault(input));
    this.roadUserFocusInputs().forEach((input) => {
      input.checked = input.defaultChecked;
    });
    this.normalizeClusterRadius();
    this.normalizeNumberInput(this.elements.minAccidents);
    this.normalizeSeverityPercentInputs();
    this.setDirty(false);
  }

  populateFilters(availableStateCodes: Set<string>, years: number[]): void {
    const selectedState = this.elements.stateFilter.value;
    const previousYearInputs = Array.from(this.elements.yearFilter.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
    const selectedYears = new Set(previousYearInputs.filter((input) => input.checked).map((input) => Number(input.value)));
    const hadYearFilters = previousYearInputs.length > 0;

    this.elements.stateFilter.replaceChildren(new Option(tr("option.allStates"), "all"));
    const stateOptions = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1], "de", { sensitivity: "base" }));
    for (const [code, name] of stateOptions) {
      if (availableStateCodes.has(code)) {
        this.elements.stateFilter.append(new Option(name, code));
      }
    }
    this.elements.stateFilter.value = [...this.elements.stateFilter.options].some((option) => option.value === selectedState)
      ? selectedState
      : "all";

    this.elements.yearFilter.innerHTML = "";
    for (const year of years) {
      const label = document.createElement("label");
      label.className = "year-pill";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(year);
      input.checked = hadYearFilters ? selectedYears.has(year) : true;
      input.addEventListener("change", this.deps.onDraftChange);
      label.append(input, document.createTextNode(String(year)));
      this.elements.yearFilter.append(label);
    }

    this.setControlsDisabled(this.elements.analyzeButton.disabled);
  }

  normalizeClusterRadius(): void {
    this.normalizeLinkedNumberRange(this.elements.clusterRadius, this.elements.clusterRadiusOut);
  }

  readOptions(): AnalysisOptions {
    const years = new Set<number>();
    this.elements.yearFilter.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach((input) => {
      if (input.checked) {
        years.add(Number(input.value));
      }
    });

    return {
      clusterRadiusMeters: Number(this.elements.clusterRadiusOut.value),
      minAccidents: this.normalizeNumberInput(this.elements.minAccidents),
      years,
      roadUserFocus: this.readRoadUserFocus(),
      stateCode: this.elements.stateFilter.value as AnalysisOptions["stateCode"],
      severityPercent: this.readSeverityPercentOptions()
    };
  }

  updateRangeOutputs(): void {
    this.elements.clusterRadiusOut.value = this.elements.clusterRadius.value;
  }

  setDisabled(isDisabled: boolean): void {
    this.elements.analyzeButton.disabled = isDisabled;
    this.setControlsDisabled(isDisabled);
    this.updateAnalyzeButton();
  }

  setDirty(isDirty: boolean): void {
    this.dirty = isDirty;
    this.updateAnalyzeButton();
  }

  private wireLinkedNumberRange(range: HTMLInputElement, numberInput: HTMLInputElement): void {
    range.addEventListener("input", () => {
      numberInput.value = range.value;
      this.deps.onDraftChange();
    });

    numberInput.addEventListener("input", () => {
      const value = Number(numberInput.value);
      if (Number.isFinite(value)) {
        range.value = String(clampNumber(value, this.inputMin(range), this.inputMax(range)));
      }
      this.deps.onDraftChange();
    });

    numberInput.addEventListener("change", () => {
      this.normalizeLinkedNumberRange(range, numberInput);
      this.deps.onDraftChange();
    });
  }

  private wireClampedNumberInput(input: HTMLInputElement): void {
    input.addEventListener("input", this.deps.onDraftChange);
    input.addEventListener("change", () => {
      this.normalizeNumberInput(input);
      this.deps.onDraftChange();
    });
  }

  private wireClampedDecimalInput(input: HTMLInputElement): void {
    input.addEventListener("input", this.deps.onDraftChange);
    input.addEventListener("change", () => {
      this.normalizeDecimalInput(input);
      this.deps.onDraftChange();
    });
  }

  private resetInputToDefault(input: HTMLInputElement): void {
    if (input.defaultValue !== "") {
      input.value = input.defaultValue;
    }
  }

  private normalizeLinkedNumberRange(range: HTMLInputElement, numberInput: HTMLInputElement): void {
    const fallback = Number(range.value);
    const value = Number.isFinite(Number(numberInput.value)) ? Number(numberInput.value) : fallback;
    const normalized = clampNumber(value, this.inputMin(numberInput), this.inputMax(numberInput));
    numberInput.value = String(normalized);
    range.value = String(normalized);
  }

  private normalizeNumberInput(input: HTMLInputElement): number {
    const fallback = Number.isFinite(Number(input.defaultValue)) ? Number(input.defaultValue) : this.inputMin(input);
    const value = Number.isFinite(Number(input.value)) ? Number(input.value) : fallback;
    const normalized = Math.trunc(clampNumber(value, this.inputMin(input), this.inputMax(input)));
    input.value = String(normalized);
    return normalized;
  }

  private normalizeDecimalInput(input: HTMLInputElement): number {
    const fallback = Number.isFinite(Number(input.defaultValue)) ? Number(input.defaultValue) : this.inputMin(input);
    const value = Number.isFinite(Number(input.value)) ? Number(input.value) : fallback;
    const normalized = clampNumber(value, this.inputMin(input), this.inputMax(input));
    input.value = this.formatInputNumber(normalized);
    return normalized;
  }

  private normalizeSeverityPercentInputs(): void {
    this.normalizeNumberInput(this.elements.severityFullSample);
    this.normalizeNumberInput(this.elements.severityTrendYears);
    this.severityPercentDecimalInputs().forEach((input) => this.normalizeDecimalInput(input));
  }

  private severityPercentInputs(): HTMLInputElement[] {
    return [
      this.elements.fatalWeight,
      this.elements.seriousWeight,
      this.elements.severityFullSample,
      this.elements.severityTrendYears,
      this.elements.severityTrendDeadZone,
      this.elements.severityTrendFullSignal,
      this.elements.severityMaxTrendAdjustment,
      this.elements.severityMaxPercent
    ];
  }

  private severityPercentDecimalInputs(): HTMLInputElement[] {
    return [
      this.elements.fatalWeight,
      this.elements.seriousWeight,
      this.elements.severityTrendDeadZone,
      this.elements.severityTrendFullSignal,
      this.elements.severityMaxTrendAdjustment,
      this.elements.severityMaxPercent
    ];
  }

  private formatInputNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(round(value, 4));
  }

  private readRoadUserFocus(): Set<RoadUserKey> {
    const focus = new Set<RoadUserKey>();
    this.roadUserFocusInputs().forEach((input) => {
      if (input.checked && this.isRoadUserKey(input.value)) {
        focus.add(input.value);
      }
    });
    return focus;
  }

  private roadUserFocusInputs(): HTMLInputElement[] {
    return Array.from(this.elements.roadUserFocus.querySelectorAll<HTMLInputElement>("input[data-road-user-focus]"));
  }

  private isRoadUserKey(value: string): value is RoadUserKey {
    return ROAD_USER_DEFINITIONS.some((definition) => definition.key === value);
  }

  private readSeverityPercentOptions(): SeverityPercentOptions {
    const trendDeadZonePercent = this.normalizeDecimalInput(this.elements.severityTrendDeadZone);
    const trendFullSignalPercent = Math.max(trendDeadZonePercent + 0.1, this.normalizeDecimalInput(this.elements.severityTrendFullSignal));
    this.elements.severityTrendFullSignal.value = this.formatInputNumber(trendFullSignalPercent);

    return {
      fatalWeight: this.normalizeDecimalInput(this.elements.fatalWeight),
      seriousWeight: this.normalizeDecimalInput(this.elements.seriousWeight),
      fullSampleAccidents: this.normalizeNumberInput(this.elements.severityFullSample),
      trendYears: this.normalizeNumberInput(this.elements.severityTrendYears),
      trendDeadZone: trendDeadZonePercent / 100,
      trendFullSignal: trendFullSignalPercent / 100,
      maxTrendAdjustment: this.normalizeDecimalInput(this.elements.severityMaxTrendAdjustment) / 100,
      maxSeverityPercent: this.normalizeDecimalInput(this.elements.severityMaxPercent) / 100
    };
  }

  private setControlsDisabled(isDisabled: boolean): void {
    const controls: HTMLElement[] = [
      this.elements.clusterRadius,
      this.elements.clusterRadiusOut,
      this.elements.minAccidents,
      this.elements.stateFilter,
      ...this.severityPercentInputs()
    ];
    this.roadUserFocusInputs().forEach((input) => controls.push(input));
    this.elements.yearFilter.querySelectorAll<HTMLInputElement>("input").forEach((input) => controls.push(input));

    for (const control of controls) {
      if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLButtonElement) {
        control.disabled = isDisabled;
      }
    }
  }

  private updateAnalyzeButton(): void {
    this.elements.analyzeButton.textContent = this.dirty ? tr("action.analyzeChanges") : tr("action.analyze");
    this.elements.analyzeButton.classList.toggle("dirty", this.dirty);
  }

  private inputMin(input: HTMLInputElement): number {
    return input.min === "" ? Number.NEGATIVE_INFINITY : Number(input.min);
  }

  private inputMax(input: HTMLInputElement): number {
    return input.max === "" ? Number.POSITIVE_INFINITY : Number(input.max);
  }
}
