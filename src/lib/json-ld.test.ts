import { describe, expect, it } from "vitest";
import { serializeJsonLd } from "./json-ld";

describe("serializeJsonLd", () => {
  it("neutralizes script boundaries without changing the JSON value", () => {
    const value = {
      description: "</script><script>alert('x')</script>",
      detail: "A & B > C\u2028next\u2029paragraph",
    };

    const serialized = serializeJsonLd(value);

    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toMatch(/[<>&\u2028\u2029]/u);
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
