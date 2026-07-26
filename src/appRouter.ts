import { tr } from "./i18n";

const MOBILE_LAYOUT_QUERY = "(max-width: 640px)";
const VIEW_URL_PARAM = "view";

export type AppViewKey = "explore" | "map" | "details" | "state" | "region" | "similar" | "table" | "settings";

export interface AppRouterElements {
  app: HTMLElement;
  exploreTab: HTMLButtonElement;
  mapTab: HTMLButtonElement;
  detailsTab: HTMLButtonElement;
  moreTab: HTMLButtonElement;
  stateTab: HTMLButtonElement;
  regionTab: HTMLButtonElement;
  similarTab: HTMLButtonElement;
  tableTab: HTMLButtonElement;
  settingsTab: HTMLButtonElement;
  mobileMoreMenu: HTMLElement;
  mobileStateTab: HTMLButtonElement;
  mobileRegionTab: HTMLButtonElement;
  mobileTableTab: HTMLButtonElement;
  mobileSettingsTab: HTMLButtonElement;
  mapView: HTMLElement;
  stateView: HTMLElement;
  regionView: HTMLElement;
  similarView: HTMLElement;
  tableView: HTMLElement;
  settingsView: HTMLElement;
}

export interface AppRouterDependencies {
  canOpenDetails: () => boolean;
  canOpenSimilar: () => boolean;
  setStatus: (message: string, progress: number) => void;
  onViewChanged: (view: AppViewKey) => void;
  scheduleMapRefresh: () => void;
}

export class AppRouter {
  private readonly mobileLayout = window.matchMedia(MOBILE_LAYOUT_QUERY);
  private activeViewValue: AppViewKey = "map";

  constructor(
    private readonly elements: AppRouterElements,
    private readonly deps: AppRouterDependencies
  ) {}

  get activeView(): AppViewKey {
    return this.activeViewValue;
  }

  get isMobileLayout(): boolean {
    return this.mobileLayout.matches;
  }

  bindEvents(): void {
    this.elements.exploreTab.addEventListener("click", () => this.setView("explore"));
    this.elements.mapTab.addEventListener("click", () => this.setView("map"));
    this.elements.detailsTab.addEventListener("click", () => this.setView("details"));
    this.elements.moreTab.addEventListener("click", (event) => this.toggleMobileMoreMenu(event));
    this.elements.stateTab.addEventListener("click", () => this.setView("state"));
    this.elements.regionTab.addEventListener("click", () => this.setView("region"));
    this.elements.similarTab.addEventListener("click", () => this.setView("similar"));
    this.elements.tableTab.addEventListener("click", () => this.setView("table"));
    this.elements.settingsTab.addEventListener("click", () => this.setView("settings"));
    this.elements.mobileStateTab.addEventListener("click", () => this.setView("state"));
    this.elements.mobileRegionTab.addEventListener("click", () => this.setView("region"));
    this.elements.mobileTableTab.addEventListener("click", () => this.setView("table"));
    this.elements.mobileSettingsTab.addEventListener("click", () => this.setView("settings"));
    document.addEventListener("click", (event) => this.closeMobileMoreMenuOnOutsideClick(event));
    document.addEventListener("keydown", (event) => this.closeMobileMoreMenuOnEscape(event));
    this.mobileLayout.addEventListener("change", () => this.handleLayoutChange());
  }

  initialView(): AppViewKey {
    const urlView = this.readViewFromUrl();
    if (urlView) {
      return urlView;
    }
    return this.mobileLayout.matches ? "explore" : "map";
  }

  setView(requestedView: AppViewKey): void {
    let view = requestedView;
    if (view === "details" && !this.deps.canOpenDetails()) {
      this.deps.setStatus(tr("details.selectFirst"), 100);
      view = "map";
    }
    if (view === "similar" && !this.deps.canOpenSimilar()) {
      this.deps.setStatus(this.deps.canOpenDetails() ? tr("similar.selectComparable") : tr("details.selectFirst"), 100);
      view = "map";
    }

    this.activeViewValue = view;
    this.elements.app.dataset.activeView = view;
    this.updateViewUrl(view);
    this.updateTabs(view);
    this.updateViews(view);
    this.deps.onViewChanged(view);
    this.setMobileMoreMenuOpen(false);
    this.deps.scheduleMapRefresh();
  }

  shouldRefreshMap(): boolean {
    return !this.mobileLayout.matches || this.activeViewValue === "map";
  }

  private readViewFromUrl(): AppViewKey | null {
    return this.parseUrlView(new URLSearchParams(window.location.search).get(VIEW_URL_PARAM));
  }

  private parseUrlView(value: string | null): AppViewKey | null {
    const normalizedValue = value?.trim().toLocaleLowerCase("en");
    switch (normalizedValue) {
      case "browse":
      case "explore":
        return "explore";
      case "map":
        return "map";
      case "details":
        return "details";
      case "state":
        return "state";
      case "region":
        return "region";
      case "similar":
        return "similar";
      case "intersections":
      case "table":
        return "table";
      case "settings":
        return "settings";
      default:
        return null;
    }
  }

  private urlViewValue(view: AppViewKey): string {
    return view === "table" ? "intersections" : view;
  }

  private updateViewUrl(view: AppViewKey): void {
    const url = new URL(window.location.href);
    if (view === "map") {
      if (!url.searchParams.has(VIEW_URL_PARAM)) {
        return;
      }
      url.searchParams.delete(VIEW_URL_PARAM);
      window.history.replaceState(window.history.state, "", url.toString());
      return;
    }

    const urlValue = this.urlViewValue(view);
    if (url.searchParams.get(VIEW_URL_PARAM) === urlValue) {
      return;
    }
    url.searchParams.set(VIEW_URL_PARAM, urlValue);
    window.history.replaceState(window.history.state, "", url.toString());
  }

  private updateTabs(view: AppViewKey): void {
    const tabs = [
      { key: "explore", tab: this.elements.exploreTab },
      { key: "map", tab: this.elements.mapTab },
      { key: "details", tab: this.elements.detailsTab },
      { key: "similar", tab: this.elements.similarTab },
      { key: "state", tab: this.elements.stateTab },
      { key: "state", tab: this.elements.mobileStateTab },
      { key: "region", tab: this.elements.regionTab },
      { key: "region", tab: this.elements.mobileRegionTab },
      { key: "table", tab: this.elements.tableTab },
      { key: "table", tab: this.elements.mobileTableTab },
      { key: "settings", tab: this.elements.settingsTab },
      { key: "settings", tab: this.elements.mobileSettingsTab }
    ] as const;

    for (const entry of tabs) {
      const active = entry.key === view;
      entry.tab.classList.toggle("active", active);
      if (entry.tab.getAttribute("role") === "tab") {
        entry.tab.setAttribute("aria-selected", String(active));
      } else {
        entry.tab.toggleAttribute("aria-current", active);
      }
    }
    this.elements.moreTab.classList.toggle("active", this.isSecondaryView(view));
  }

  private updateViews(view: AppViewKey): void {
    this.elements.mapView.classList.toggle("active", view === "map" || view === "details");
    this.elements.stateView.classList.toggle("active", view === "state");
    this.elements.regionView.classList.toggle("active", view === "region");
    this.elements.similarView.classList.toggle("active", view === "similar");
    this.elements.tableView.classList.toggle("active", view === "table");
    this.elements.settingsView.classList.toggle("active", view === "settings");
  }

  private isMobilePaneView(view: AppViewKey): boolean {
    return view === "explore" || view === "details";
  }

  private isSecondaryView(view: AppViewKey): boolean {
    return view === "state" || view === "region" || view === "table" || view === "settings";
  }

  private toggleMobileMoreMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.setMobileMoreMenuOpen(this.elements.mobileMoreMenu.hidden);
  }

  private setMobileMoreMenuOpen(isOpen: boolean): void {
    this.elements.mobileMoreMenu.hidden = !isOpen;
    this.elements.moreTab.setAttribute("aria-expanded", String(isOpen));
  }

  private closeMobileMoreMenuOnOutsideClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (this.elements.mobileMoreMenu.contains(target) || this.elements.moreTab.contains(target)) {
      return;
    }
    this.setMobileMoreMenuOpen(false);
  }

  private closeMobileMoreMenuOnEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.setMobileMoreMenuOpen(false);
    }
  }

  private handleLayoutChange(): void {
    if (!this.mobileLayout.matches && this.isMobilePaneView(this.activeViewValue)) {
      this.setView("map");
      return;
    }
    this.setMobileMoreMenuOpen(false);
    this.deps.scheduleMapRefresh();
  }
}
