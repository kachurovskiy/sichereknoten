export type LoadingStatusKind = "normal" | "problem" | "idle";

export interface LoadingStatusPresenterElements {
  splash: HTMLElement;
  mapLoadingTitle: HTMLElement;
  mapLoadingStatus: HTMLElement;
  mapLoadingBar: HTMLElement;
}

export interface LoadingStatusPresenterDependencies {
  elements: LoadingStatusPresenterElements;
  hasNoClusters: () => boolean;
  onShowSplash: () => void;
  translate: (key: string) => string;
}

export class LoadingStatusPresenter {
  private isSplashDisplayed: boolean;

  constructor(private readonly deps: LoadingStatusPresenterDependencies) {
    this.isSplashDisplayed = !deps.elements.splash.hidden;
  }

  setBusy(isBusy: boolean): void {
    if (isBusy && !this.isSplashDisplayed) {
      this.deps.onShowSplash();
    }
    this.isSplashDisplayed = isBusy;
    this.deps.elements.splash.hidden = !isBusy;
    this.deps.elements.splash.setAttribute("aria-busy", String(isBusy));
  }

  setStatus(message: string, progress: number, kind: LoadingStatusKind = "normal"): void {
    const normalizedProgress = normalizeLoadingProgress(progress);
    const titleKey = loadingTitleKey(normalizedProgress, kind, this.deps.hasNoClusters());

    this.deps.elements.mapLoadingStatus.textContent = message;
    this.deps.elements.mapLoadingBar.style.width = `${normalizedProgress}%`;
    this.deps.elements.mapLoadingTitle.textContent = this.deps.translate(titleKey);
  }
}

export function normalizeLoadingProgress(progress: number): number {
  return Math.max(0, Math.min(100, progress));
}

export function loadingTitleKey(progress: number, kind: LoadingStatusKind, hasNoClusters: boolean): string {
  if (kind === "problem") {
    return "loading.title.problem";
  }
  if (kind === "idle") {
    return "loading.title.idle";
  }
  if (hasNoClusters && progress >= 100) {
    return "loading.title.noMatches";
  }
  if (progress >= 100) {
    return "loading.title.ready";
  }
  if (progress >= 75) {
    return "loading.title.analyze";
  }
  if (progress >= 10) {
    return "loading.title.result";
  }
  return "loading.title.bundle";
}
