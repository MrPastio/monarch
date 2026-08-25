export function createLatestRequestOwner() {
  let current = Symbol('initial-request-owner');
  return Object.freeze({
    begin() {
      current = Symbol('request-owner');
      return current;
    },
    invalidate() {
      current = Symbol('invalidated-request-owner');
    },
    isCurrent(token) {
      return token === current;
    },
  });
}
