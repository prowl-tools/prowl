import { describe, expect, it } from "vitest";

import { isExpressionAllowed, isLicenseAllowed, runAudit } from "../scripts/audit-licenses.mjs";

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

describe("license audit gate", () => {
  it("passes an allowed runtime dependency tree", async () => {
    const result = await runAudit({
      packageTree: {
        dependencies: {
          chalk: {
            version: "5.0.0",
            dependencies: {
              ansi: { version: "1.0.0" },
            },
          },
        },
      },
      licenseData: {
        "ansi@1.0.0": { licenses: "MIT" },
        "chalk@5.0.0": { licenses: "MIT" },
      },
    });

    expect(result).toEqual({
      scannedCount: 2,
      failures: [],
      exceptionsUsed: [],
    });
  });

  it("fails disallowed and missing runtime license data", async () => {
    const result = await runAudit({
      packageTree: {
        dependencies: {
          copyleft: { version: "1.0.0" },
          mystery: { version: "2.0.0" },
        },
      },
      licenseData: {
        "copyleft@1.0.0": { licenses: "GPL-3.0-only" },
      },
    });

    expect(result.scannedCount).toBe(2);
    expect(result.exceptionsUsed).toEqual([]);
    expect(result.failures).toEqual([
      "copyleft@1.0.0: \"GPL-3.0-only\"",
      "mystery@2.0.0: UNKNOWN (no license data)",
    ]);
  });

  it("excludes optional, dev-only, extraneous, and missing packages from the gate", async () => {
    const result = await runAudit({
      packageTree: {
        dependencies: {
          runtime: { version: "1.0.0" },
          optionalBad: { version: "1.0.0", optional: true },
          devBad: { version: "1.0.0", dev: true },
          extraneousBad: { version: "1.0.0", extraneous: true },
          missingBad: { version: "1.0.0", missing: true },
        },
      },
      licenseData: {
        "runtime@1.0.0": { licenses: "Apache-2.0" },
        "optionalBad@1.0.0": { licenses: "GPL-3.0-only" },
        "devBad@1.0.0": { licenses: "GPL-3.0-only" },
        "extraneousBad@1.0.0": { licenses: "GPL-3.0-only" },
        "missingBad@1.0.0": { licenses: "GPL-3.0-only" },
      },
    });

    expect(result).toEqual({
      scannedCount: 1,
      failures: [],
      exceptionsUsed: [],
    });
  });
});
