'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const { setupTestDb } = require('../helpers/db');

describe('Postgres HA integration', () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    const { close } = require('../../src/db/postgres');
    await close();
  });

  it('can connect to Postgres', async () => {
    const { query } = require('../../src/db/postgres');
    const result = await query('SELECT NOW()');
    assert(result.rows[0].now);
  });

  it('can run migrations', async () => {
    const { ensureSchema } = require('../../src/db/migrate-postgres');
    await ensureSchema();
  });

  it('can create and query account', async () => {
    const { Account } = require('../../src/models');
    const emailHmac = `test-${Date.now()}@example.com`;
    const account = await Account.create({
      emailHmac,
      username: 'testuser',
    });
    assert(account.id);

    const found = await Account.findById(account.id).lean();
    assert(found.emailHmac === emailHmac);

    await Account.deleteOne({ _id: account.id });
  });

  it('can use transactions', async () => {
    const { transaction } = require('../../src/db/postgres');
    const result = await transaction(async (client) => {
      const res = await client.query('SELECT 1 as num');
      return res.rows[0].num;
    });
    assert(result === 1);
  });
});
