'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Data migration', () => {
  it('migration script exists and is callable', () => {
    const { migrateSqliteToPostgres } = require('../../scripts/migrate-sqlite-to-pg');
    assert(typeof migrateSqliteToPostgres === 'function');
  });
});
