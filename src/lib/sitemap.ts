export function includeInSitemap(page: string): boolean {
  const pathname = new URL(page).pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/search") return false;
  return !/\.(?:json|md|txt|xml)$/i.test(pathname);
}
