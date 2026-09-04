const URL_LIKE = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i;
const HOST_LIKE = /^https?:\/\/[\w.-]+(:\d+)?([/?#]\S*)?$/i;

/** Splits one CSV line, honouring double quotes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else current += ch;
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

/**
 * Extracts URLs from CSV text. Works with a single-column file, a file with a header
 * row, or a multi-column file where one column holds the URL.
 */
export function extractUrlsFromCsv(text: string): string[] {
  const urls: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = splitCsvLine(line);
    const match = cells.find((c) => HOST_LIKE.test(c)) ?? cells.find((c) => URL_LIKE.test(c));
    if (match) urls.push(match);
  }
  return urls;
}
