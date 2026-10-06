import { describe, expect, it } from "vitest";
import { addDays, dateRange, daysBetween, isWeekend, parseIsoDate } from "./dates.js";

describe("dates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("builds inclusive ranges", () => {
    expect(dateRange("2026-10-01", "2026-10-03")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });

  it("detects weekends in UTC", () => {
    expect(isWeekend("2026-10-03")).toBe(true); // Saturday
    expect(isWeekend("2026-10-05")).toBe(false); // Monday
  });

  it("rejects malformed dates", () => {
    expect(() => parseIsoDate("10/05/2026")).toThrow();
  });
});
