// Keep explicit versions: different arXiv revisions must not share an attachment.
export function parseArxivId(value: string): string | null {
  const id = "(\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[a-z-]+)?/\\d{7})(v[1-9]\\d*)?";
  const prefix =
    "(?:https?://(?:www\\.|export\\.)?arxiv\\.org/(?:abs|pdf|src|e-print)/|(?:https?://(?:dx\\.)?doi\\.org/)?10\\.48550/arxiv\\.|arxiv(?:\\s+id)?[:.\\s]+)?";
  const match = value
    .trim()
    .match(new RegExp(`^${prefix}${id}(?:\\.pdf)?(?:[?#].*)?$`, "i"));
  return match ? `${match[1]}${(match[2] || "").toLowerCase()}` : null;
}

export function parseArxivExtra(extra: string): string | null {
  for (const line of extra.split(/\r?\n/)) {
    const parsed = parseArxivId(line.replace(/^\s*DOI:\s*/i, ""));
    if (parsed) return parsed;
  }
  return null;
}
