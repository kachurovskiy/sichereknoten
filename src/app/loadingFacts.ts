import type { AppLocale } from "../shared/i18n";

export const DEFAULT_LOADING_FACT_META: Record<AppLocale, string> = {
  en: "Germany · 2025 · Destatis",
  de: "Deutschland · 2025 · Destatis"
};
export const LOADING_FACTS: Array<{ text: Record<AppLocale, string>; meta?: Record<AppLocale, string> }> = [
  {
    text: {
      en: "On an average day, 8 people died and more than 1,000 were injured in road crashes.",
      de: "An einem durchschnittlichen Tag starben 8 Menschen bei Verkehrsunfällen, mehr als 1.000 wurden verletzt."
    }
  },
  {
    text: {
      en: "Police recorded about 2.52 million road crashes - nearly five every minute.",
      de: "Die Polizei erfasste rund 2,52 Millionen Verkehrsunfälle - fast fünf pro Minute."
    }
  },
  {
    text: {
      en: "Within built-up areas, 63% of road deaths were pedestrians or cyclists.",
      de: "Innerorts waren 63 % der Verkehrstoten Fußgängerinnen, Fußgänger oder Radfahrende."
    }
  },
  {
    text: {
      en: "Failure to yield was cited in 15% of crashes involving injury or death.",
      de: "Missachten der Vorfahrt wurde bei 15 % der Unfälle mit Personenschaden genannt."
    }
  },
  {
    text: {
      en: "Speeding or inappropriate speed was involved in 29% of road deaths.",
      de: "Nicht angepasste Geschwindigkeit spielte bei 29 % der Verkehrstoten eine Rolle."
    }
  },
  {
    text: {
      en: "An alcohol-related crash occurred about every 15 minutes.",
      de: "Etwa alle 15 Minuten ereignete sich ein alkoholbedingter Verkehrsunfall."
    }
  },
  {
    text: {
      en: "A child under 15 was injured in a road crash about every 18 minutes.",
      de: "Etwa alle 18 Minuten wurde ein Kind unter 15 Jahren bei einem Verkehrsunfall verletzt."
    }
  },
  {
    text: {
      en: "People aged 65 or older accounted for 39% of road deaths.",
      de: "Menschen ab 65 Jahren machten 39 % der Verkehrstoten aus."
    }
  },
  {
    text: {
      en: "Serious injuries fell to about 49,200 - the lowest recorded level since 1991.",
      de: "Die Zahl der Schwerverletzten sank auf rund 49.200 - den niedrigsten Stand seit 1991."
    }
  },
  {
    text: {
      en: "One road death represents about €1.47 million in societal loss.",
      de: "Ein Verkehrstoter steht für etwa 1,47 Mio. € gesellschaftliche Kosten."
    },
    meta: {
      en: "Per casualty · Germany 2024 · BASt",
      de: "Je Verunglücktem · Deutschland 2024 · BASt"
    }
  },
  {
    text: {
      en: "One serious road injury represents about €149,000 in societal loss.",
      de: "Eine schwer verletzte Person im Straßenverkehr steht für etwa 149.000 € gesellschaftliche Kosten."
    },
    meta: {
      en: "Per casualty · Germany 2024 · BASt",
      de: "Je Verunglücktem · Deutschland 2024 · BASt"
    }
  },
  {
    text: {
      en: "Even a minor road injury represents about €6,600 in societal loss.",
      de: "Selbst eine leicht verletzte Person im Straßenverkehr steht für etwa 6.600 € gesellschaftliche Kosten."
    },
    meta: {
      en: "Per casualty · Germany 2024 · BASt",
      de: "Je Verunglücktem · Deutschland 2024 · BASt"
    }
  },
  {
    text: {
      en: "Germany's road crashes cost society €40.19 billion in 2024 - about €110 million every day.",
      de: "Deutschlands Straßenverkehrsunfälle verursachten 2024 gesellschaftliche Kosten von 40,19 Mrd. € - etwa 110 Mio. € pro Tag."
    },
    meta: {
      en: "Germany 2024 · BASt",
      de: "Deutschland 2024 · BASt"
    }
  }
];
