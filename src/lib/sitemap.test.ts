import { describe, expect, it } from "vitest";
import { includeInSitemap } from "./sitemap";

describe("includeInSitemap", () => {
  it("excludes the noindex search page", () => {
    expect(includeInSitemap("https://archive.example/search/")).toBe(false);
    expect(includeInSitemap("https://archive.example/search")).toBe(false);
  });

  it("excludes machine-readable alternates and sitemap endpoints", () => {
    expect(includeInSitemap("https://archive.example/archive.json")).toBe(false);
    expect(includeInSitemap("https://archive.example/llms.txt")).toBe(false);
    expect(includeInSitemap("https://archive.example/video-sitemap.xml")).toBe(false);
    expect(includeInSitemap("https://archive.example/videos/example.md")).toBe(false);
  });

  it("keeps public archive pages", () => {
    expect(includeInSitemap("https://archive.example/")).toBe(true);
    expect(includeInSitemap("https://archive.example/videos/example/")).toBe(true);
  });
});
