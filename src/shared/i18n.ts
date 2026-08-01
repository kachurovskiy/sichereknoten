export type AppLocale = "en" | "de";

let activeLocale: AppLocale = "en";
let translations: Record<AppLocale, Record<string, string>> = {
  en: {},
  de: {}
};

export function configureI18n(locale: AppLocale, sourceTranslations: Record<AppLocale, Record<string, string>>): void {
  activeLocale = locale;
  translations = sourceTranslations;
}

export function detectLocale(languages: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language]): AppLocale {
  for (const language of languages) {
    const languageCode = language.toLowerCase().split("-")[0];
    if (languageCode === "de" || languageCode === "en") {
      return languageCode;
    }
  }
  return "en";
}

export function currentLocale(): AppLocale {
  return activeLocale;
}

export function tr(key: string): string {
  return translations[activeLocale][key] ?? translations.en[key] ?? key;
}

export function trf(key: string, values: Record<string, string | number>): string {
  return tr(key).replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
}

export function applyStaticTranslations(root: ParentNode = document): void {
  document.documentElement.lang = activeLocale;
  document.title = tr("document.title");
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (key) {
      element.textContent = tr(key);
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((element) => {
    const key = element.dataset.i18nHtml;
    if (key) {
      element.innerHTML = tr(key);
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.dataset.i18nAriaLabel;
    if (key) {
      element.setAttribute("aria-label", tr(key));
    }
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle;
    if (key) {
      element.setAttribute("title", tr(key));
    }
  });
}
