export function includeInSitemap(page: string): boolean {
  const pathname = new URL(page).pathname.replace(/\/+$/, "") || "/";
  return pathname !== "/search";
}
