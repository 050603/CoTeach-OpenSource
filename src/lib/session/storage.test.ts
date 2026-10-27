import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearJSON, loadJSON, saveJSON, STORAGE_KEY } from "./storage";

describe("storage — loadJSON / saveJSON", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns the fallback when the key does not exist", () => {
    expect(loadJSON("missing", "default")).toBe("default");
    expect(loadJSON("missing", { a: 1 })).toEqual({ a: 1 });
    expect(loadJSON<number[]>("missing", [])).toEqual([]);
  });

  it("round-trips a JSON value through save and load", () => {
    saveJSON("test-key", { name: "张三", age: 18 });
    const loaded = loadJSON<{ name: string; age: number } | null>("test-key", null);
    expect(loaded).toEqual({ name: "张三", age: 18 });
  });

  it("handles arrays and primitive values", () => {
    saveJSON("arr", [1, 2, 3]);
    expect(loadJSON<number[]>("arr", [])).toEqual([1, 2, 3]);

    saveJSON("num", 42);
    expect(loadJSON<number>("num", 0)).toBe(42);

    saveJSON("bool", true);
    expect(loadJSON<boolean>("bool", false)).toBe(true);
  });

  it("returns fallback for invalid JSON", () => {
    window.localStorage.setItem("bad", "{not valid json}");
    expect(loadJSON("bad", "fallback")).toBe("fallback");
  });

  it("overwrites the previous value on subsequent saves", () => {
    saveJSON("key", "first");
    saveJSON("key", "second");
    expect(loadJSON<string>("key", "")).toBe("second");
  });
});

describe("storage — clearJSON", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("removes the stored value", () => {
    saveJSON("to-clear", { data: 123 });
    expect(loadJSON<{ data: number } | null>("to-clear", null)).toEqual({ data: 123 });

    clearJSON("to-clear");
    expect(loadJSON("to-clear", "gone")).toBe("gone");
  });

  it("does not throw when clearing a non-existent key", () => {
    expect(() => clearJSON("never-set")).not.toThrow();
  });
});

describe("storage — STORAGE_KEY constant", () => {
  it("exports the expected key name", () => {
    expect(STORAGE_KEY).toBe("openpbl.session.v1");
  });
});
