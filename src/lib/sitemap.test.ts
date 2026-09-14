import { describe, expect, it } from "vitest";
import { includeInSitemap } from "./sitemap";

describe("includeInSitemap", () => {
  it("excludes the noindex search page", () => {
    expect(includeInSitemap("https://archive.example/search/")).toBe(false);
    expect(includeInSitemap("https://archive.example/search")).toBe(false);
  });

  it("keeps public archive pages", () => {
    expect(includeInSitemap("https://archive.example/")).toBe(true);
    expect(includeInSitemap("https://archive.example/videos/example/")).toBe(true);
  });
});
