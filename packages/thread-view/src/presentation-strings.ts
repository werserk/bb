const strings = {
  "plan.failed": { en: "Failed", ru: "Ошибка" },
} as const;

export function threadPresentationText(
  key: keyof typeof strings,
  locale: string,
): string {
  return strings[key][locale.toLowerCase().startsWith("ru") ? "ru" : "en"];
}
