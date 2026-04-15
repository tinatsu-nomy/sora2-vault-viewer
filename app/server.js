const runtime = require("./server_runtime");

if (require.main === module) {
  runtime.startServer();
}

module.exports = runtime;
