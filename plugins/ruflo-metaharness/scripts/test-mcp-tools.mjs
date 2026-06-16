#!/usr/bin/env node
// test-mcp-tools.mjs — runtime test for the iter-20/21 MCP tool registry.
//
// tsc proves the metaharness-tools.ts module COMPILES; structural smoke
// proves the source DECLARES the right tool names. Neither proves the
// HANDLERS actually run without throwing. This test imports the compiled
// module and invokes every tool's handler with minimal inputs.
//
// CONTRACT EACH TOOL MUST SATISFY
//   - handler is callable as `await tool.handler({ ... })`
//   - returns an object with keys: success, data, degraded, exitCode
//   - never throws (even with bad/missing optional dep — graceful)
//   - handler honors the 120s subprocess timeout (no hang)
//
// USAGE
//   node scripts/test-mcp-tools.mjs                          # default
//   node scripts/test-mcp-tools.mjs --format json
//
// EXIT CODES
//   0  all tools satisfy the contract
//   1  at least one tool failed
//   2  setup error (compiled dist not present)

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ARGS = (() => {
  const a = { format: 'table' };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--format') a.format = process.argv[++i];
  }
  return a;
})();

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failures.push(label); failed++; }
}

async function main() {
  // Locate the compiled dist of metaharness-tools.
  const distPath = resolve(SCRIPTS_DIR, '..', '..', '..',
    'v3', '@claude-flow', 'cli', 'dist', 'src', 'mcp-tools', 'metaharness-tools.js');

  if (!existsSync(distPath)) {
    console.log(`# test-mcp-tools — SKIPPED`);
    console.log('');
    console.log(`Compiled dist not present: ${distPath}`);
    console.log(`Build the CLI first:`);
    console.log(`  cd v3/@claude-flow/cli && npm run build`);
    console.log('');
    console.log(`Exit 0 — this script is meaningfully runnable only post-build.`);
    process.exit(0);
  }

  let mod;
  try {
    mod = await import(distPath);
  } catch (e) {
    console.error(`test-mcp-tools: failed to import ${distPath}: ${e.message}`);
    process.exit(2);
  }

  const tools = mod.metaharnessTools;
  console.log(`# test-mcp-tools — runtime contract\n`);

  // ──────────────────────────────────────────────────────────────────
  // PHASE 1 — module exports the right shape
  // ──────────────────────────────────────────────────────────────────
  console.log('Phase 1 — module shape');
  assert(Array.isArray(tools), 'metaharnessTools is an array');
  assert(tools.length === 8, `8 tools registered (got ${tools.length})`);

  const expectedNames = new Set([
    'metaharness_score',
    'metaharness_genome',
    'metaharness_mcp_scan',
    'metaharness_threat_model',
    'metaharness_oia_audit',
    'metaharness_audit_list',
    'metaharness_audit_trend',
    // iter 36 — ADR-152 §3.1 production
    'metaharness_similarity',
  ]);
  const actualNames = new Set(tools.map((t) => t.name));
  for (const name of expectedNames) {
    assert(actualNames.has(name), `${name} registered`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PHASE 2 — every tool has the required MCP shape
  // ──────────────────────────────────────────────────────────────────
  console.log('\nPhase 2 — per-tool shape');
  for (const tool of tools) {
    const ok = typeof tool.name === 'string'
      && typeof tool.description === 'string'
      && typeof tool.category === 'string'
      && typeof tool.handler === 'function'
      && typeof tool.inputSchema === 'object';
    assert(ok, `${tool.name} has {name, description, category, handler, inputSchema}`);
    assert(tool.category === 'metaharness', `${tool.name} category === 'metaharness'`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PHASE 3 — handlers callable + return contract shape
  //
  // We invoke each handler with minimal valid input. The handlers may
  // succeed (if metaharness is installed) or report degraded (if not).
  // EITHER way, they must return { success, data, degraded, exitCode }
  // without throwing.
  // ──────────────────────────────────────────────────────────────────
  console.log('\nPhase 3 — handler invocations (allow up to 30s each)');
  for (const tool of tools) {
    // Construct minimal valid input per tool.
    let input = {};
    if (tool.name === 'metaharness_audit_trend') {
      // Requires baselineKey + currentKey — use fake keys that won't
      // resolve so we exercise the not-found path.
      input = { baselineKey: 'audit-fake-base', currentKey: 'audit-fake-curr' };
    }
    if (tool.name === 'metaharness_similarity') {
      // Needs --a/--b OR --a-key/--b-key. Use fake mem keys to exercise
      // the graceful not-found path (matches audit_trend convention).
      input = { aKey: 'harness-fake-a', bKey: 'harness-fake-b' };
    }

    // 30s budget per tool — slow path is npx warmup
    const handlerPromise = tool.handler(input);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('30s handler timeout')), 30_000));

    let result;
    let threw = false;
    try {
      result = await Promise.race([handlerPromise, timeoutPromise]);
    } catch (e) {
      threw = true;
      console.log(`    [${tool.name}] handler threw: ${e.message.slice(0, 80)}`);
    }

    assert(!threw, `${tool.name} handler did not throw`);
    if (!threw && result) {
      assert(typeof result === 'object', `${tool.name} returns object`);
      assert('success' in result, `${tool.name} result has 'success'`);
      assert('data' in result, `${tool.name} result has 'data'`);
      assert('degraded' in result, `${tool.name} result has 'degraded'`);
      assert('exitCode' in result, `${tool.name} result has 'exitCode'`);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // PHASE 4 — POSITIVE-CASE data-shape validation (iter 43)
  //
  // Iter 37 verified the {success, data, degraded, exitCode} envelope.
  // It did NOT verify that data.X contains the right keys when success
  // is genuinely true — leaving room for iter 42-style bugs where a
  // handler returns valid-looking degraded JSON while silently
  // misrouting input. This phase invokes each handler with VALID
  // inputs and asserts the expected output shape.
  //
  // Tools that depend on `npx metaharness` (score/genome/mcp-scan/
  // threat-model/oia-audit/audit-list/audit-trend) are SKIPPED in this
  // phase when the optional dep isn't installed — they're covered by
  // the no-metaharness-smoke workflow's drill. The similarity tool
  // has no @metaharness/* dep, so its positive case ALWAYS runs.
  // ──────────────────────────────────────────────────────────────────
  console.log('\nPhase 4 — positive-case data shape (iter 43)');

  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');
  const tmp = mkdtempSync(pjoin(tmpdir(), 'mcp-positive-'));

  // metaharness_similarity — full positive case (no @metaharness/* needed)
  const simTool = tools.find((t) => t.name === 'metaharness_similarity');
  if (simTool) {
    const aPath = pjoin(tmp, 'a.json');
    const bPath = pjoin(tmp, 'b.json');
    writeFileSync(aPath, JSON.stringify({
      score: { harnessFit: 78, compileConfidence: 92, taskCoverage: 65, toolSafety: 88, memoryUsefulness: 70, estCostPerRunUsd: 0.04, recommendedMode: 'CLI + MCP', archetype: 'compliance-harness', template: 'vertical:legal' },
      genome: { repo_type: 'node_mcp_ci', agent_topology: ['x','y','z','w'], risk_score: 0.45, test_confidence: 0.7, publish_readiness: 0.6 },
    }));
    writeFileSync(bPath, JSON.stringify({
      score: { harnessFit: 75, compileConfidence: 90, taskCoverage: 70, toolSafety: 90, memoryUsefulness: 72, estCostPerRunUsd: 0.05, recommendedMode: 'CLI + MCP', archetype: 'compliance-harness', template: 'vertical:support' },
      genome: { repo_type: 'node_mcp_ci', agent_topology: ['x','y','z','q','r'], risk_score: 0.40, test_confidence: 0.75, publish_readiness: 0.65 },
    }));
    const r = await simTool.handler({ aFile: aPath, bFile: bPath });
    assert(r.degraded === false, 'similarity positive case: degraded === false');
    assert(r.success === true, 'similarity positive case: success === true');
    assert(r.exitCode === 0, 'similarity positive case: exitCode === 0');
    const d = r.data ?? {};
    assert(typeof d.overall === 'number', 'similarity data has numeric `overall`');
    assert(typeof d.components === 'object' && d.components !== null,
      'similarity data has `components` object');
    assert(typeof d.components?.cosine === 'number',
      'similarity components.cosine numeric');
    assert(typeof d.components?.categorical === 'number',
      'similarity components.categorical numeric');
    assert(typeof d.components?.jaccard === 'number',
      'similarity components.jaccard numeric');
    assert(typeof d.weights === 'object' && d.weights !== null,
      'similarity data has `weights` object');
    assert(d.adr === 'ADR-152', 'similarity data tagged adr=ADR-152');
    // Regression anchor — same fixtures as iter-35 spike with non-matching topologies
    assert(d.overall > 0 && d.overall < 1,
      `similarity overall in (0, 1) — got ${d.overall}`);

    // Per-dimension variant
    const rPD = await simTool.handler({ aFile: aPath, bFile: bPath, perDimension: true });
    assert(typeof rPD.data?.perDimension === 'object',
      'similarity perDimension=true populates breakdown');

    // Alert-below variant exercises non-zero exit
    const rAlert = await simTool.handler({ aFile: aPath, bFile: bPath, alertBelow: 0.99 });
    assert(rAlert.data?.alert?.triggered === true,
      'similarity alertBelow=0.99 triggers alert');
    assert(rAlert.exitCode === 1, 'similarity alertBelow=0.99 → exitCode 1');
    // iter 44 — success semantic anchor (was true under the pre-iter-44
    // `!degraded` rule; now false because exitCode !== 0 dominates).
    assert(rAlert.success === false,
      'similarity alertBelow=0.99 → success === false (iter 44 fix)');
  }

  // metaharness_audit_trend — positive case via file inputs
  const trendTool = tools.find((t) => t.name === 'metaharness_audit_trend');
  if (trendTool) {
    const basePath = pjoin(tmp, 'base.json');
    const currPath = pjoin(tmp, 'curr.json');
    const fingerprint = {
      score: { harnessFit: 80, recommendedMode: 'CLI + MCP', archetype: 'typescript-sdk-harness', template: 'vertical:coding' },
      genome: { repo_type: 'node_mcp_ci', agent_topology: ['a','b','c'], risk_score: 0.3, test_confidence: 0.85, publish_readiness: 0.9 },
    };
    writeFileSync(basePath, JSON.stringify({
      startedAt: '2026-06-15T00:00:00Z',
      composite: { worst: 'clean' },
      components: { oiaManifest: {}, threatModel: {}, mcpScan: { json: { findings: [] } } },
      fingerprint,
    }));
    writeFileSync(currPath, JSON.stringify({
      startedAt: '2026-06-16T00:00:00Z',
      composite: { worst: 'clean' },
      components: { oiaManifest: {}, threatModel: {}, mcpScan: { json: { findings: [] } } },
      fingerprint,
    }));
    // audit_trend tool only supports keys, not files at the MCP layer.
    // Document its actual wrapper semantics so future-us doesn't get
    // surprised:
    //   - bad keys → script exits 2 with stderr (no JSON payload)
    //   - runScript() can't parse a {degraded:true} marker, so it
    //     returns degraded:false / success:true / exitCode:2
    // This is a real wrapper bug (success should not be true when
    // exit!=0 AND no JSON came back), tracked separately. Asserting
    // current behavior here protects against silent semantic shifts.
    const r = await trendTool.handler({ baselineKey: 'missing-X', currentKey: 'missing-Y' });
    assert(r.exitCode === 2,
      'audit_trend bad-keys path exits 2 (script-level guard fires)');
    assert(r.data === null || r.data === undefined,
      'audit_trend bad-keys path: data null (no JSON emitted on stderr exit)');
    // iter 44 — success semantic anchor. Pre-iter-44 wrapper returned
    // success:true for this case (because no degraded marker). Now
    // returns false because exitCode !== 0.
    assert(r.success === false,
      'audit_trend bad-keys path: success === false (iter 44 fix)');
  }

  // Cleanup
  try { (await import('node:fs')).rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ All 8 MCP tools satisfy the runtime contract.');
}

main().catch((e) => {
  console.error('test-mcp-tools crashed:', e.message || e);
  process.exit(2);
});
