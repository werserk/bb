export function hasVisibleMatch(selector: string): boolean {
  for (const element of document.querySelectorAll(selector)) {
    if (element.checkVisibility?.() ?? true) {
      return true;
    }
  }
  return false;
}
