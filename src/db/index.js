'use strict';

// Postgres-only backend. SQLite support has been removed.

function getBackend() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required (Postgres-only backend)');
  }
  return require('./postgres');
}

function getDb() {
  const b = getBackend();
  return { query: b.query, transaction: b.transaction };
}

function query(text, params) {
  return getBackend().query(text, params);
}

function transaction(fn) {
  return getBackend().transaction(fn);
}

function close() {
  return getBackend().close();
}

module.exports = { getDb, close, query, transaction };
