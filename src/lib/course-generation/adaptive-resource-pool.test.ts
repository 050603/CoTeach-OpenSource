import { describe, expect, it } from "vitest";
import { runAdaptiveResourcePool } from "./adaptive-resource-pool";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("adaptive resource pool", () => {
  it("runs at most three branches while preserving result order", async () => {
    const gates = Array.from({ length: 7 }, () => deferred());
    let active = 0;
    let maxActive = 0;
    const running = runAdaptiveResourcePool(
      gates.map((_, index) => index),
      async (item, _index, report) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await report(0.5);
        await gates[item]!.promise;
        active -= 1;
        return `branch-${item}`;
      },
    );

    await Promise.resolve();
    expect(maxActive).toBe(3);
    gates.slice(0, 3).forEach((gate) => gate.resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBe(3);
    gates.slice(3).forEach((gate) => gate.resolve());

    const results = await running;
    expect(results.map((result) => result.status)).toEqual(Array(7).fill("fulfilled"));
    expect(results.map((result) => result.status === "fulfilled" ? result.value : "failed"))
      .toEqual(gates.map((_, index) => `branch-${index}`));
  });

  it("isolates one branch failure and still completes the other branches", async () => {
    const results = await runAdaptiveResourcePool([0, 1, 2], async (item) => {
      if (item === 1) throw new Error("branch failed");
      return item * 2;
    });
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1]?.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 4 });
  });
});

