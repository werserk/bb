const MAX_CODE_POINT = 0x10ffff;
const LAST_HIGH_SURROGATE = 0xdbff;
const FIRST_CODE_POINT_AFTER_SURROGATES = 0xe000;

export interface PrefixRange {
  lower: string;
  upper: string | null;
}

function isHighSurrogate(character: string | undefined): boolean {
  const codePoint = character?.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdbff;
}

export function codePointPrefixRange(prefix: string): PrefixRange {
  const characters = Array.from(prefix);
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const codePoint = characters[index]!.codePointAt(0)!;
    if (codePoint < MAX_CODE_POINT) {
      const successor =
        codePoint === LAST_HIGH_SURROGATE &&
        isHighSurrogate(characters[index - 1])
          ? FIRST_CODE_POINT_AFTER_SURROGATES
          : codePoint + 1;
      return {
        lower: prefix,
        upper:
          characters.slice(0, index).join("") +
          String.fromCodePoint(successor),
      };
    }
  }
  return { lower: prefix, upper: null };
}
