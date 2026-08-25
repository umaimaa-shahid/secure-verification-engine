const { createModel } = require("../lib/prisma-model");

module.exports = createModel("emailLog", { attempts: 0, status: "queued" });
