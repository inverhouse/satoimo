import { describe, expect, it } from "vitest";
import { displayedExportPercent, isFinalizingExport } from "./exportProgress";

describe("export progress", () => {
  it("does not show 100 percent until the output file is finalized", () => {
    expect(displayedExportPercent(99.9)).toBe(99);
    expect(displayedExportPercent(100)).toBe(100);
  });

  it("identifies the finalization phase", () => {
    expect(isFinalizingExport(98.9)).toBe(false);
    expect(isFinalizingExport(99)).toBe(true);
    expect(isFinalizingExport(100)).toBe(false);
  });
});
