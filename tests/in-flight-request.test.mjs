import assert from "node:assert/strict";
import test from "node:test";

import { createInFlightRequestCoordinator } from "../src/lib/in-flight-request.mjs";

test("coalesces a slow request by scope until it settles", async () => {
  const coordinator = createInFlightRequestCoordinator();
  let finishSlowRequest;
  let slowRequestCalls = 0;

  const first = coordinator.run("account-1:room-1", () => {
    slowRequestCalls += 1;
    return new Promise((resolve) => {
      finishSlowRequest = resolve;
    });
  });
  const second = coordinator.run("account-1:room-1", () => {
    slowRequestCalls += 1;
    return Promise.resolve();
  });

  assert.strictEqual(second, first);
  assert.equal(slowRequestCalls, 1);

  finishSlowRequest();
  await first;

  await coordinator.run("account-1:room-1", () => {
    slowRequestCalls += 1;
    return Promise.resolve();
  });
  assert.equal(slowRequestCalls, 2);
});

test("leaving and rejoining the same room starts a new scoped request", async () => {
  const coordinator = createInFlightRequestCoordinator();
  let finishOldRequest;
  let finishNewRequest;
  let newRequestCalls = 0;

  const oldRequest = coordinator.run(
    "account-1:1:room-1:room-1",
    () => new Promise((resolve) => {
      finishOldRequest = resolve;
    }),
  );
  const newRequest = coordinator.run("account-1:1:main:room-1", () => {
    newRequestCalls += 1;
    return new Promise((resolve) => {
      finishNewRequest = resolve;
    });
  });

  finishOldRequest();
  await oldRequest;

  const coalescedNewRequest = coordinator.run("account-1:1:main:room-1", () => {
    newRequestCalls += 1;
    return Promise.resolve();
  });
  assert.strictEqual(coalescedNewRequest, newRequest);
  assert.equal(newRequestCalls, 1);

  finishNewRequest();
  await newRequest;
});
