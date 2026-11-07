const strings = {
  "service.busy": {
    en: "Busy with service work; your message is next",
    ru: "занят служебной работой, твоё сообщение следующее",
  },
  "plan.failed": { en: "Failed", ru: "Ошибка" },
} as const;

export function threadPresentationText(
  key: keyof typeof strings,
  locale: string,
): string {
  return strings[key][locale.toLowerCase().startsWith("ru") ? "ru" : "en"];
}
