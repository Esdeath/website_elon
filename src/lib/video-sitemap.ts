export const VIDEO_TITLE_MAX_LENGTH = 100;
export const VIDEO_DESCRIPTION_MAX_LENGTH = 2048;

export interface VideoSitemapEntry {
  loc: string;
  thumbnailLoc?: string;
  title: string;
  description: string;
  playerLoc?: string;
  publicationDate: string;
  durationSec?: number;
}

function isXmlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;

  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

export function escapeXml(value: string, maxLength?: number): string {
  const characters = Array.from(value.trim()).filter(isXmlCharacter);
  const truncated = maxLength === undefined ? characters : characters.slice(0, maxLength);

  return truncated
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isHttpUrl(value?: string): value is string {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isPublicationDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function validDuration(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 && value <= 28_800 ? value : undefined;
}

function serializeEntry(entry: VideoSitemapEntry): string | undefined {
  const title = escapeXml(entry.title, VIDEO_TITLE_MAX_LENGTH);
  const description = escapeXml(entry.description, VIDEO_DESCRIPTION_MAX_LENGTH);
  if (
    !isHttpUrl(entry.loc) ||
    !isHttpUrl(entry.thumbnailLoc) ||
    !isHttpUrl(entry.playerLoc) ||
    !isPublicationDate(entry.publicationDate) ||
    !title ||
    !description
  ) {
    return undefined;
  }

  const duration = validDuration(entry.durationSec);
  const lines = [
    "  <url>",
    `    <loc>${escapeXml(entry.loc)}</loc>`,
    "    <video:video>",
    `      <video:thumbnail_loc>${escapeXml(entry.thumbnailLoc)}</video:thumbnail_loc>`,
    `      <video:title>${title}</video:title>`,
    `      <video:description>${description}</video:description>`,
    `      <video:player_loc allow_embed="yes">${escapeXml(entry.playerLoc)}</video:player_loc>`,
    `      <video:publication_date>${entry.publicationDate}</video:publication_date>`,
  ];

  if (duration !== undefined) {
    lines.push(`      <video:duration>${duration}</video:duration>`);
  }

  lines.push("    </video:video>", "  </url>");
  return lines.join("\n");
}

export function buildVideoSitemap(entries: Iterable<VideoSitemapEntry>): string {
  const serializedEntries = Array.from(entries, serializeEntry).filter(
    (entry): entry is string => entry !== undefined,
  );
  const body = serializedEntries.length > 0 ? `\n${serializedEntries.join("\n")}\n` : "\n";

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ' +
    'xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">' +
    body +
    "</urlset>\n"
  );
}
