import { describe, expect, test } from "bun:test";
import { validateMarkers, zone } from "../lib/replaymap.ts";

describe("zone", () => {
  test("bases and halves", () => {
    expect(zone(75, 75)).toBe("Radiant base");
    expect(zone(180, 180)).toBe("Dire base");
    expect(zone(100, 140)).toBe("Radiant half, top side");
    expect(zone(150, 160)).toBe("Dire half, top side");
    expect(zone(160, 110)).toBe("Dire half, bot side");
  });
  test("river and mid", () => {
    expect(zone(128, 128)).toBe("mid lane, river");
    expect(zone(110, 112)).toBe("mid lane, Radiant half");
    expect(zone(110, 146)).toBe("river, top side");
    expect(zone(150, 104)).toBe("river, bot side");
  });
});

describe("validateMarkers", () => {
  test("accepts an array or {markers}", () => {
    const m = [{ kind: "ward", x: 120.04, y: 140, from: 10, to: 20, label: "  ward   here " }];
    expect(validateMarkers(m)).toEqual([{ kind: "ward", x: 120, y: 140, from: 10, to: 20, label: "ward here" }]);
    expect(validateMarkers({ markers: m })).toHaveLength(1);
    expect(validateMarkers([])).toEqual([]);
  });
  test("rejects bad input", () => {
    expect(() => validateMarkers({})).toThrow(/array/);
    expect(() => validateMarkers([{ kind: "nope", x: 100, y: 100, label: "x" }])).toThrow(/kind/);
    expect(() => validateMarkers([{ kind: "ward", x: 10, y: 100, label: "x" }])).toThrow(/x must/);
    expect(() => validateMarkers([{ kind: "ward", x: 100, y: 100, label: "" }])).toThrow(/label/);
    expect(() => validateMarkers([{ kind: "ward", x: 100, y: 100, label: "x", from: 20, to: 10 }])).toThrow(/before/);
    expect(() => validateMarkers(Array.from({ length: 13 }, () => ({ kind: "ward", x: 100, y: 100, label: "x" })))).toThrow(/12/);
  });
});
