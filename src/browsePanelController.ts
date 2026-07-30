import {
  DEFAULT_BROWSE_CLUSTER_FILTERS,
  browseFilterActiveCount,
  regionOptionLabel,
  type BrowseClusterFilters,
  type BrowseFatalFilter,
  type BrowseFeatureFilter,
  type BrowseIndex
} from "./browseIndex";
import type { BrowseFilterProgress } from "./browseFilterWorkerClient";
import { formatInteger } from "./formatting";
import { tr, trf } from "./i18n";
import { clampNumber, round } from "./math";
import { STATE_NAMES } from "./states";

export interface BrowsePanelElements {
  filtersToggle: HTMLButtonElement;
  filters: HTMLElement;
  roundaboutFilter: HTMLSelectElement;
  trafficSignalFilter: HTMLSelectElement;
  fatalFilter: HTMLSelectElement;
  addressQuery: HTMLInputElement;
  minSeverity: HTMLInputElement;
  maxSeverity: HTMLInputElement;
  resetFilters: HTMLButtonElement;
  searchStatus: HTMLElement;
  searchStatusText: HTMLElement;
  state: HTMLSelectElement;
  regionField: HTMLElement;
  region: HTMLSelectElement;
}

export interface BrowsePanelControllerDependencies {
  hasResult: () => boolean;
  browseIndex: () => BrowseIndex | null;
  onBrowseChange: () => void;
}

export class BrowsePanelController {
  constructor(
    private readonly elements: BrowsePanelElements,
    private readonly deps: BrowsePanelControllerDependencies
  ) {}

  bindEvents(): void {
    this.elements.state.addEventListener("change", () => {
      this.updateRegionOptions();
      this.deps.onBrowseChange();
    });
    this.elements.region.addEventListener("change", this.deps.onBrowseChange);
    this.elements.filtersToggle.addEventListener("click", () => this.setFiltersExpanded(this.elements.filters.hidden));
    this.elements.resetFilters.addEventListener("click", () => this.resetFilters());
    [this.elements.roundaboutFilter, this.elements.trafficSignalFilter, this.elements.fatalFilter].forEach((select) => {
      select.addEventListener("change", () => this.updateFilterResults());
    });
    [this.elements.minSeverity, this.elements.maxSeverity].forEach((input) => {
      input.addEventListener("input", () => this.updateFilterResults());
      input.addEventListener("change", () => {
        this.normalizeSeverityInput(input);
        this.updateFilterResults();
      });
    });
    this.elements.addressQuery.placeholder = tr("browse.filters.addressPlaceholder");
    this.elements.addressQuery.addEventListener("input", () => this.updateFilterResults());
    this.updateFiltersToggleText();
    this.setSearchProgress(null);
  }

  populateStateOptions(availableStateCodes: Set<string>): void {
    const selectedState = this.elements.state.value;
    const selectedRegion = this.elements.region.value;

    this.elements.state.replaceChildren(new Option(tr("option.allStates"), "all"));
    const stateOptions = Object.entries(STATE_NAMES).sort((a, b) => a[1].localeCompare(b[1], "de", { sensitivity: "base" }));
    for (const [code, name] of stateOptions) {
      if (availableStateCodes.has(code)) {
        this.elements.state.append(new Option(name, code));
      }
    }
    this.elements.state.value = [...this.elements.state.options].some((option) => option.value === selectedState)
      ? selectedState
      : "all";
    this.updateRegionOptions(selectedRegion);
  }

  updateRegionOptions(preferredRegion = this.elements.region.value): void {
    const stateCode = this.stateValue();
    const shouldShow = this.deps.hasResult() && stateCode !== "all";
    this.elements.regionField.hidden = !shouldShow;
    this.elements.region.disabled = !shouldShow;

    if (!shouldShow) {
      this.elements.region.replaceChildren(new Option(tr("option.allRegions"), "all"));
      this.elements.region.value = "all";
      return;
    }

    const regions = this.deps.browseIndex()?.regionsByState.get(stateCode) ?? [];
    this.elements.region.replaceChildren(new Option(tr("option.allRegions"), "all"));
    for (const region of regions) {
      this.elements.region.append(new Option(regionOptionLabel(region), region.key));
    }
    this.elements.region.value = [...this.elements.region.options].some((option) => option.value === preferredRegion)
      ? preferredRegion
      : "all";
  }

  stateValue(): string {
    return this.elements.state.value;
  }

  regionValue(): string {
    return this.elements.region.value;
  }

  filtersValue(): BrowseClusterFilters {
    return {
      roundabout: this.readFeatureFilter(this.elements.roundaboutFilter.value),
      trafficSignal: this.readFeatureFilter(this.elements.trafficSignalFilter.value),
      fatal: this.readFatalFilter(this.elements.fatalFilter.value),
      addressQuery: this.elements.addressQuery.value.trim(),
      minSeverityPercent: this.readOptionalSeverityPercent(this.elements.minSeverity),
      maxSeverityPercent: this.readOptionalSeverityPercent(this.elements.maxSeverity)
    };
  }

  setSearchProgress(progress: BrowseFilterProgress | null): void {
    const isSearching = progress !== null;
    this.elements.resetFilters.hidden = isSearching;
    this.elements.searchStatus.hidden = !isSearching;
    if (!progress) {
      this.elements.searchStatusText.textContent = "";
      return;
    }
    this.elements.searchStatusText.textContent = trf("browse.search.scanned", {
      current: formatInteger(progress.scannedCount),
      total: formatInteger(progress.totalCount)
    });
  }

  private setFiltersExpanded(isExpanded: boolean): void {
    this.elements.filters.hidden = !isExpanded;
    this.elements.filtersToggle.setAttribute("aria-expanded", String(isExpanded));
    this.updateFiltersToggleText();
  }

  private resetFilters(): void {
    this.elements.roundaboutFilter.value = DEFAULT_BROWSE_CLUSTER_FILTERS.roundabout;
    this.elements.trafficSignalFilter.value = DEFAULT_BROWSE_CLUSTER_FILTERS.trafficSignal;
    this.elements.fatalFilter.value = DEFAULT_BROWSE_CLUSTER_FILTERS.fatal;
    this.elements.addressQuery.value = DEFAULT_BROWSE_CLUSTER_FILTERS.addressQuery;
    this.elements.minSeverity.value = "";
    this.elements.maxSeverity.value = "";
    this.updateFilterResults();
  }

  private updateFilterResults(): void {
    this.updateFiltersToggleText();
    this.deps.onBrowseChange();
  }

  private updateFiltersToggleText(): void {
    const activeCount = browseFilterActiveCount(this.filtersValue());
    const isExpanded = !this.elements.filters.hidden;
    const key =
      activeCount > 0
        ? isExpanded
          ? "browse.filters.hideCount"
          : "browse.filters.showCount"
        : isExpanded
          ? "browse.filters.hide"
          : "browse.filters.show";
    this.elements.filtersToggle.textContent =
      activeCount > 0 ? trf(key, { count: formatInteger(activeCount) }) : tr(key);
  }

  private readFeatureFilter(value: string): BrowseFeatureFilter {
    return value === "yes" || value === "no" || value === "unknown" ? value : "any";
  }

  private readFatalFilter(value: string): BrowseFatalFilter {
    return value === "yes" || value === "no" ? value : "any";
  }

  private readOptionalSeverityPercent(input: HTMLInputElement): number | null {
    if (input.value.trim() === "") {
      return null;
    }
    const value = Number(input.value);
    return Number.isFinite(value) ? clampNumber(value, 0, 100) : null;
  }

  private normalizeSeverityInput(input: HTMLInputElement): void {
    const value = this.readOptionalSeverityPercent(input);
    input.value = value === null ? "" : String(round(value, 1));
  }
}
