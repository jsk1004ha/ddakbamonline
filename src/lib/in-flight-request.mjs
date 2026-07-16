export function createInFlightRequestCoordinator() {
  let active = null;

  return {
    run(scope, request) {
      if (active?.scope === scope) return active.promise;

      const token = Symbol(scope);
      let requestPromise;
      try {
        requestPromise = Promise.resolve(request());
      } catch (error) {
        requestPromise = Promise.reject(error);
      }
      const promise = requestPromise.finally(() => {
        if (active?.token === token) active = null;
      });
      active = { scope, token, promise };
      return promise;
    },
  };
}
