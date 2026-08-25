const { stopTestDatabase } = require("./testDatabase");
const { stopTestApi } = require("./testApi");

/** Runs once after the whole suite, tearing down in reverse order. */
module.exports = async () => {
  await stopTestApi();
  await stopTestDatabase();
};
