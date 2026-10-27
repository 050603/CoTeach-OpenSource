import { describe, expect, it } from "vitest";
import { readNestedPayloadEnum } from "./persisted-payload";

const submissionTypes = ["document", "showcase"] as const;

describe("readNestedPayloadEnum", () => {
  it("reads a normal persisted enum field", () => {
    expect(
      readNestedPayloadEnum(
        { type: "showcase", title: "成果展示" },
        "type",
        submissionTypes,
        "document",
      ),
    ).toBe("showcase");
  });

  it("recovers an enum from repeatedly nested legacy payloads", () => {
    let payload: unknown = { type: "showcase", title: "成果展示" };
    for (let depth = 0; depth < 150; depth += 1) {
      payload = { type: payload, title: "成果展示" };
    }

    expect(
      readNestedPayloadEnum(payload, "type", submissionTypes, "document"),
    ).toBe("showcase");
  });

  it("uses the fallback for invalid or cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.type = cyclic;

    expect(
      readNestedPayloadEnum(cyclic, "type", submissionTypes, "document"),
    ).toBe("document");
    expect(
      readNestedPayloadEnum(
        { type: "unsupported" },
        "type",
        submissionTypes,
        "document",
      ),
    ).toBe("document");
  });
});
