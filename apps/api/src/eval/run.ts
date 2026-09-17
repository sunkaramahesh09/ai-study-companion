/**
 * `npm run eval` — the CLI entry point.
 *
 * Exits non-zero when any case fails, so this can gate a deploy. The PRD asks
 * for awareness that prompt, model and retrieval changes cause regressions
 * (§14); an evaluation that always exits 0 provides none.
 */
import { ALL_CASES, runEvaluation } from './runner.ts';
import type { Suite } from './types.ts';
import { stopQueue } from '../lib/queue.ts';

const VALID_SUITES: Suite[] = ['tutor', 'retrieval', 'assessment', 'recommendation', 'security'];

async function main() {
  const arg = process.argv[2];
  if (arg === '--list') {
    for (const c of ALL_CASES) console.log(`${pad(c.suite, 15)} ${pad(c.id, 52)} ${c.intent}`);
    return;
  }

  const suite = arg && !arg.startsWith('-') ? (arg as Suite) : undefined;
  if (suite && !VALID_SUITES.includes(suite)) {
    console.error(`Unknown suite "${suite}". One of: ${VALID_SUITES.join(', ')}`);
    process.exit(2);
  }

  console.log(`\nAI evaluation — ${suite ? `suite: ${suite}` : `${ALL_CASES.length} cases across ${VALID_SUITES.length} suites`}`);
  console.log(`Cases run sequentially: TPM is the binding constraint, so parallelism would just buy backoff.\n`);

  const result = await runEvaluation({
    suite,
    onProgress: (m) => console.log(`  ${m}`),
  });

  console.log(`\n${'─'.repeat(78)}`);
  for (const [name, s] of Object.entries(result.summary)) {
    const mean = s.mean_score === null ? '   —' : `${Math.round(s.mean_score * 100)}%`;
    const flag = s.failed > 0 ? 'FAIL' : ' ok ';
    console.log(`  [${flag}] ${pad(name, 16)} ${s.passed} passed, ${s.failed} failed${s.errored > 0 ? `, ${s.errored} errored` : ''}   mean ${mean}`);
  }
  console.log(`${'─'.repeat(78)}`);

  const failures = result.outcomes.filter((o) => !o.passed);
  if (failures.length > 0) {
    console.log(`\nFailures:\n`);
    for (const f of failures) {
      console.log(`  ✗ ${f.caseId}`);
      console.log(`    ${ALL_CASES.find((c) => c.id === f.caseId)?.intent ?? ''}`);
      console.log(`    ${JSON.stringify(f.detail).slice(0, 600)}\n`);
    }
  }

  if (result.cost) {
    console.log(
      `\n  Spent: ${result.cost.requests} AI requests, ${result.cost.totalTokens.toLocaleString()} tokens, ` +
        `~$${result.cost.estimatedCostUsd.toFixed(5)}`,
    );
  }

  console.log(
    `\n${result.passed}/${result.outcomes.length} cases passed in ${Math.round(result.durationMs / 1000)}s` +
      `${result.runId ? ` · run ${result.runId}` : ''}\n`,
  );

  // Closing the queue explicitly: processMaterial chains a follow-up job, which
  // opens a pg-boss connection that would otherwise keep the process alive.
  await stopQueue();
  process.exit(failures.length > 0 ? 1 : 0);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

main().catch(async (err) => {
  console.error(`\nEvaluation could not run: ${(err as Error).message}\n`);
  await stopQueue().catch(() => {});
  process.exit(2);
});
