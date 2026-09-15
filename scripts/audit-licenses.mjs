#!/usr/bin/env node
/**
 * Dependency license audit (PROWL-011 / LEGAL-002).
 *
 * Fails CI when any package in Prowl's *core runtime* dependency tree carries a
 * license that is not on the permissive allowlist below. This guards against a
 * transitive dependency silently pulling in an incompatible (e.g. GPL/AGPL)
 * copyleft license.
 *
 * ── Scope: core runtime deps only ────────────────────────────────────────────
 * We audit `dependencies` and their transitive tree, i.e. what the desktop-first
 * (macOS) and web CLI actually loads at runtime and ships to users. Two buckets
 * are intentionally excluded:
 *
 *   • devDependencies — build/test tooling (tsup, eslint, vitest, this checker).
 *     Never shipped: the published tarball ships only `dist/` (see package.json
 *     `files`), so dev-tool licenses never reach a user's machine.
 *
 *   • optionalDependencies — `appium-webdriveragent` / `appium-uiautomator2-server`,
 *     the helpers for the *experimental* iOS/Android targets (see the focus
 *     decision in the workspace CLAUDE.md: mobile is experimental, desktop-first
 *     is the product). Their transitive tree is large and license-heterogeneous
 *     (LGPL native libvips binary via sharp, WTFPL, CC0, BlueOak, dual-license
 *     expressions) but all permissive or weak-copyleft-via-dynamic-linking, and
 *     none of it is part of the core product. Gating core CI on the churn of the
 *     experimental mobile toolchain would be noisy and out of scope. If mobile is
 *     ever promoted out of experimental, extend this audit to cover it.
 *
 * The scope is derived from `npm ls --omit=dev --omit=optional`, so it tracks the
 * real resolved lockfile tree rather than a hand-maintained list.
 *
 * Run locally with: npm run audit:licenses
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Permissive / public-domain-equivalent SPDX identifiers we accept. Anything not
 * expressible as a satisfiable combination of these fails the audit and must be
 * reviewed by a human — either the dependency is dropped, or (if genuinely safe)
 * an explicit, commented entry is added to EXCEPTIONS below. Do NOT widen this
 * list to silence a single package; use EXCEPTIONS so the reason is recorded.
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

/**
 * Per-package license exceptions: `"name@version": "reason"`.
 * Only for packages whose declared license is outside ALLOWED but has been
 * reviewed and cleared. Pin the exact version so a bump forces a re-review.
 * Currently empty — the core runtime tree is fully permissive.
 */
const EXCEPTIONS = Object.create(null);

/** Collect the core runtime package set (name@version) from the resolved tree. */
function collectCorePackages() {
  const raw = execFileSync(
    'npm',
    ['ls', '--omit=dev', '--omit=optional', '--all', '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const tree = JSON.parse(raw);
  const set = new Set();
  /** Walk a resolved npm dependency node and collect reachable packages. */
  const visit = (node) => {
    const deps = node.dependencies || {};
    for (const [name, info] of Object.entries(deps)) {
      // Skip nodes that are not really part of this scope's resolved tree:
      // `extraneous` = present on disk but unreachable once optional edges are
      // omitted (e.g. sharp's platform binaries reached only via appium).
      if (info.extraneous || info.missing || !info.version) continue;
      set.add(`${name}@${info.version}`);
      visit(info);
    }
  };
  visit(tree);
  return set;
}

/** license-checker license data for every installed package: { "name@ver": {licenses} }. */
async function collectLicenseData() {
  const checker = await import('license-checker-rseidelsohn');
  return new Promise((resolve, reject) => {
    checker.init({ start: process.cwd() }, (err, packages) => {
      if (err) reject(err);
      else resolve(packages);
    });
  });
}

/** Normalize an atomic license token: drop a trailing `*` (guessed) and outer parens. */
function normalizeAtom(atom) {
  return atom.replace(/\*+$/, '').trim();
}

/**
 * Evaluate an SPDX license expression against ALLOWED.
 * Supports parentheses, `AND` (all must be allowed) and `OR` (any allowed).
 * `AND` binds tighter than `OR`, per SPDX.
 */
function isExpressionAllowed(expr) {
  const tokens = expr
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .split(/\s+/)
    .filter(Boolean);
  let pos = 0;
  let valid = true;
  const peek = () => tokens[pos];

  /** Parse OR chains, the lowest-precedence SPDX boolean operator. */
  function parseOr() {
    let value = parseAnd();
    while (peek() === 'OR') {
      pos++;
      const rhs = parseAnd();
      value = value || rhs;
    }
    return value;
  }
  /** Parse AND chains, which bind tighter than OR. */
  function parseAnd() {
    let value = parseAtom();
    while (peek() === 'AND') {
      pos++;
      const rhs = parseAtom();
      value = value && rhs;
    }
    return value;
  }
  /** Parse license atoms and parenthesized groups while tracking malformed tokens. */
  function parseAtom() {
    const tok = tokens[pos++];
    if (tok === undefined) return false;
    let value;
    if (tok === '(') {
      value = parseOr();
      if (peek() === ')') {
        pos++;
      } else {
        valid = false;
      }
    } else if (tok === ')' || tok === 'AND' || tok === 'OR' || tok === 'WITH') {
      valid = false;
      value = false;
    } else {
      value = ALLOWED.has(normalizeAtom(tok));
    }
    // A `WITH <exception>` clause narrows a license grant; the base license's
    // verdict stands, but the exception must be reviewed like any atom would —
    // so treat it as not-allowed unless a human adds an EXCEPTIONS entry.
    if (peek() === 'WITH') {
      pos++;
      const exception = tokens[pos++];
      if (
        exception === undefined ||
        exception === '(' ||
        exception === ')' ||
        exception === 'AND' ||
        exception === 'OR' ||
        exception === 'WITH'
      ) {
        valid = false;
      }
      return false;
    }
    return value;
  }

  if (tokens.length === 0) return false;
  const result = parseOr();
  // Fail closed on malformed expressions: leftover tokens mean we did not
  // understand the whole expression, so a human must review it.
  return valid && pos === tokens.length ? result : false;
}

/** A package's license field may be a string or an array; every entry must pass. */
function isLicenseAllowed(licenses) {
  if (!licenses) return false;
  const list = Array.isArray(licenses) ? licenses : [licenses];
  return list.every((lic) => isExpressionAllowed(String(lic)));
}

async function main() {
  const core = collectCorePackages();
  const licenseData = await collectLicenseData();

  const failures = [];
  const exceptionsUsed = [];

  for (const pkg of [...core].sort()) {
    if (pkg in EXCEPTIONS) {
      exceptionsUsed.push(`${pkg} — ${EXCEPTIONS[pkg]}`);
      continue;
    }
    const entry = licenseData[pkg];
    const licenses = entry ? entry.licenses : undefined;
    if (!isLicenseAllowed(licenses)) {
      failures.push(`${pkg}: ${licenses ? JSON.stringify(licenses) : 'UNKNOWN (no license data)'}`);
    }
  }

  console.log(`License audit: scanned ${core.size} core runtime packages (dependencies only; devDependencies and experimental-mobile optionalDependencies excluded).`);
  if (exceptionsUsed.length) {
    console.log(`\nCleared via documented exceptions (${exceptionsUsed.length}):`);
    for (const line of exceptionsUsed) console.log(`  - ${line}`);
  }

  if (failures.length) {
    console.error(`\n✗ ${failures.length} package(s) with a disallowed or unknown license:`);
    for (const line of failures) console.error(`  - ${line}`);
    console.error('\nAllowed: ' + [...ALLOWED].sort().join(', '));
    console.error('Drop the dependency, or add a reviewed, commented entry to EXCEPTIONS in scripts/audit-licenses.mjs.');
    process.exit(1);
  }

  console.log('\n✓ All core runtime dependencies use allowed licenses.');
}

export { isExpressionAllowed, isLicenseAllowed };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('License audit failed to run:', err);
    process.exit(1);
  });
}
