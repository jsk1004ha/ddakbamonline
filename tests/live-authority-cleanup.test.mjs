import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const helperUrl = new URL(
  "../scripts/live-authority-cleanup.mjs",
  import.meta.url,
);

async function loadCleanupHelper() {
  try {
    await access(helperUrl);
  } catch {
    assert.fail("expected an importable live-authority cleanup helper");
  }
  return import(helperUrl.href);
}

test("cleanup continues in order after the first step fails", async () => {
  const { runCleanupSteps } = await loadCleanupHelper();
  const attempts = [];
  const firstFailure = new Error("database cleanup rejected");
  const labels = [
    "offline obligations",
    "game result discovery",
    "game obligations",
    "game results",
    "room",
    "disposable auth user 1",
    "disposable auth user 2",
  ];
  const steps = labels.map((label, index) => ({
    label,
    run: async () => {
      attempts.push(label);
      if (index === 0) throw firstFailure;
    },
  }));

  await assert.rejects(runCleanupSteps(steps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "Disposable live QA cleanup failed");
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].message, "offline obligations cleanup failed");
    assert.equal(error.errors[0].cause, firstFailure);
    return true;
  });
  assert.deepEqual(attempts, labels);
});

test("QA failure remains primary when cleanup also fails", async () => {
  const { throwQaOrCleanupError } = await loadCleanupHelper();
  const qaFailure = new Error("primary QA failure");
  const cleanupCause = new Error("cleanup failure");
  const cleanupFailure = new AggregateError(
    [new Error("room cleanup failed", { cause: cleanupCause })],
    "Disposable live QA cleanup failed",
  );

  assert.throws(
    () => throwQaOrCleanupError(qaFailure, null),
    (error) => error === qaFailure,
  );
  assert.throws(
    () => throwQaOrCleanupError(null, cleanupFailure),
    (error) => error === cleanupFailure,
  );
  assert.throws(
    () => throwQaOrCleanupError(qaFailure, cleanupFailure),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, qaFailure);
      assert.equal(error.errors[0], qaFailure);
      assert.equal(error.errors[1], cleanupFailure.errors[0]);
      return true;
    },
  );
});
