'use strict';

const postgres = require('./postgres');

function getDb() {
  return postgres; // Returns { query, transaction }
}

function close() {
  return postgres.close();
}

module.exports = { getDb, close };
