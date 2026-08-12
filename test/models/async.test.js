'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

// Mock the postgres module before requiring models
const originalRequire = require;
const mockQuery = async (sql, params) => {
  // Return a mock result object with at least one row for count queries
  return { rows: [{}], rowCount: 0 };
};
const mockTransaction = async (fn) => {
  return await fn({ query: mockQuery });
};

describe('Async model layer', () => {
  before(() => {
    // Set dummy DATABASE_URL to prevent postgres driver from throwing
    process.env.DATABASE_URL = 'postgresql://dummy:dummy@localhost:5432/dummy';
    // Clear require cache for models
    delete require.cache[require.resolve('../../src/models')];
    // Mock the postgres module in the cache
    const postgresPath = require.resolve('../../src/db/postgres');
    require.cache[postgresPath] = {
      id: postgresPath,
      filename: postgresPath,
      loaded: true,
      exports: {
        query: mockQuery,
        transaction: mockTransaction,
        getPool: () => ({}),
      }
    };
  });

  after(() => {
    // Clean up
    delete process.env.DATABASE_URL;
    delete require.cache[require.resolve('../../src/models')];
    delete require.cache[require.resolve('../../src/db/postgres')];
  });

  it('model methods return promises', () => {
    const { Account } = require('../../src/models');
    // Verify methods are async (return promises)
    assert(typeof Account.findById('test').then === 'function');
    assert(typeof Account.findOne({}).then === 'function');
    assert(typeof Account.find({}).then === 'function');
    assert(typeof Account.create({})?.then === 'function');
    assert(typeof Account.updateOne({}, {})?.then === 'function');
    assert(typeof Account.deleteOne({})?.then === 'function');
    assert(typeof Account.deleteMany({})?.then === 'function');
    assert(typeof Account.countDocuments({})?.then === 'function');
    assert(typeof Account.findOneAndUpdate({}, {})?.then === 'function');
    assert(typeof Account.findOneAndDelete({})?.then === 'function');
  });

  it('SingleQuery and MultiQuery are thenable', () => {
    const { Account } = require('../../src/models');
    const single = Account.findById('test');
    const multi = Account.find({});
    assert(typeof single.then === 'function');
    assert(typeof multi.then === 'function');
  });

  it('async _exec resolves correctly', async () => {
    const { Account } = require('../../src/models');
    const q = Account.findById('test');
    const result = await q;
    // Mock returns [{}] so we get a Doc object back
    assert(result != null);
    assert(typeof result.toJSON === 'function');
  });
});