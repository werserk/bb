export const HUNK_CONTEXT_LINES = 3;
export const HUNK_MAX_LINES = 60;
export const HUNK_LINE_MAX_CHARS = 300;

function lines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

function range(start: number, count: number): string {
  return count === 0 ? `${start},0` : `${start + 1},${count}`;
}

function cut(line: string): string {
  return line.length > HUNK_LINE_MAX_CHARS ? `${line.slice(0, HUNK_LINE_MAX_CHARS)}…` : line;
}

export function unifiedHunk(file: string, before: string | null, after: string): string {
  const a = before === null ? [] : lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) {
    return before === after ? "(no change)" : "(only the final newline changed)";
  }
  const from = Math.max(0, start - HUNK_CONTEXT_LINES);
  const toA = Math.min(a.length, endA + HUNK_CONTEXT_LINES);
  const tail = a.slice(endA, toA);
  const body = [
    ...a.slice(from, start).map((l) => ` ${cut(l)}`),
    ...a.slice(start, endA).map((l) => `-${cut(l)}`),
    ...b.slice(start, endB).map((l) => `+${cut(l)}`),
    ...tail.map((l) => ` ${cut(l)}`),
  ];
  const countA = toA - from;
  const countB = start - from + (endB - start) + tail.length;
  const shown =
    body.length > HUNK_MAX_LINES
      ? [...body.slice(0, HUNK_MAX_LINES), `… ${body.length - HUNK_MAX_LINES} more diff lines`]
      : body;
  return [
    `--- ${before === null ? "/dev/null" : `a/${file}`}`,
    `+++ b/${file}`,
    `@@ -${range(from, countA)} +${range(from, countB)} @@`,
    ...shown,
  ].join("\n");
}
