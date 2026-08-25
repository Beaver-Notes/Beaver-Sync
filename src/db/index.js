'use strict';

// Postgres-only backend — thin facade for callers that use getDb()
const pg = require('./postgres');

module.exports = {
  query: pg.query,
  transaction: pg.transaction,
  close: pg.close,
  getDb: () => ({ query: pg.query, transaction: pg.transaction }),
};
