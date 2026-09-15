import { describe, expect, it } from "vitest";

import { isExpressionAllowed, isLicenseAllowed } from "../scripts/audit-licenses.mjs";

describe("license audit SPDX evaluator", () => {
  it("allows permissive atoms, guessed markers, and grouped expressions", () => {
    expect(isExpressionAllowed("MIT")).toBe(true);
    expect(isExpressionAllowed("MIT*")).toBe(true);
    expect(isExpressionAllowed("(MIT OR GPL-3.0-only) AND Apache-2.0")).toBe(true);
  });

  it("honors AND/OR precedence while failing closed on copyleft combinations", () => {
    expect(isExpressionAllowed("GPL-3.0-only OR MIT")).toBe(true);
    expect(isExpressionAllowed("MIT AND BSD-3-Clause")).toBe(true);
    expect(isExpressionAllowed("MIT AND GPL-3.0-only")).toBe(false);
    expect(isExpressionAllowed("GPL-3.0-only AND MIT OR Apache-2.0")).toBe(true);
  });

  it("rejects malformed parentheses even when another branch would be allowed", () => {
    expect(isExpressionAllowed("(MIT")).toBe(false);
    expect(isExpressionAllowed("MIT OR (GPL-3.0-only")).toBe(false);
    expect(isExpressionAllowed("MIT)")).toBe(false);
    expect(isExpressionAllowed("MIT OR )")).toBe(false);
  });

  it("rejects WITH clauses until a human-reviewed exception exists", () => {
    expect(isExpressionAllowed("MIT WITH Classpath-exception-2.0")).toBe(false);
    expect(isExpressionAllowed("Apache-2.0 WITH LLVM-exception")).toBe(false);
  });

  it("requires every license array entry to be allowed", () => {
    expect(isLicenseAllowed(["MIT", "Apache-2.0"])).toBe(true);
    expect(isLicenseAllowed(["MIT", "GPL-3.0-only"])).toBe(false);
  });

  it("rejects missing or unknown license data", () => {
    expect(isLicenseAllowed(undefined)).toBe(false);
    expect(isLicenseAllowed("")).toBe(false);
    expect(isLicenseAllowed("UNKNOWN")).toBe(false);
    expect(isLicenseAllowed("SEE LICENSE IN LICENSE")).toBe(false);
  });
});
