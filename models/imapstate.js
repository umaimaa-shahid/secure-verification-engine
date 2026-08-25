const { createModel } = require("../lib/prisma-model");

module.exports = createModel("imapState", { key: "bounce-listener", lastUid: 0 });
