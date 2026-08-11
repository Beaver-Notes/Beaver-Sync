'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('Postgres driver', () => {
  before(() => {
    process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  });

  after(() => {
    delete process.env.DATABASE_URL;
  });

  it('throws when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;
    assert.throws(() => require('../../src/db/postgres').getPool(), /DATABASE_URL/);
  });
});
