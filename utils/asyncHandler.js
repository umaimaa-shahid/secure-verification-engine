/**
 * Forward a rejected promise from an async route handler to Express.
 *
 * Express 5 already does this on its own. The wrapper stays because this module
 * is meant to be lifted into other client projects, some of which are still on
 * Express 4 - where an unwrapped rejection hangs the request instead of
 * producing a 500.
 *
 * @param {Function} handler - async (req, res, next) => ...
 * @returns {Function} an Express-safe handler
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
