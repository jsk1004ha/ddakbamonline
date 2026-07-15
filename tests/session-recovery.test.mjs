import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientJwtTimingError,
  retryTransientJwtRequest,
} from "../src/lib/supabase/session-recovery.mjs";

test("recognizes only PostgREST JWT clock-skew failures as transient", () => {
  assert.equal(
    isTransientJwtTimingError({
      code: "PGRST301",
      message: "JWT issued at future",
    }),
    true,
  );
  assert.equal(
    isTransientJwtTimingError({ code: "PGRST301", message: "JWT expired" }),
    false,
  );
  assert.equal(
    isTransientJwtTimingError({ code: "23505", message: "issued at future" }),
    false,
  );
});

test("waits and retries a JWT clock-skew failure exactly once", async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryTransientJwtRequest(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          data: null,
          error: { code: "PGRST301", message: "JWT issued at future" },
        };
      }
      return { data: { room_id: "room-1" }, error: null };
    },
    async (milliseconds) => {
      waits.push(milliseconds);
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(result, { data: { room_id: "room-1" }, error: null });
});

test("does not retry ordinary query failures", async () => {
  let attempts = 0;
  const failure = { data: null, error: { code: "42501", message: "denied" } };
  const result = await retryTransientJwtRequest(async () => {
    attempts += 1;
    return failure;
  });

  assert.equal(attempts, 1);
  assert.equal(result, failure);
});
