'use strict';

const crypto = require('crypto');
const { getDb } = require('../db');

function toSnake(str) {
  return str.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);
}

function keysToCamel(obj) {
  if (!isPlainObject(obj)) return obj;
  const r = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = toCamel(k);
    if (typeof v === 'string' && (k.endsWith('_at') || k.endsWith('_until')) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      r[camel] = new Date(v);
    } else {
      r[camel] = isPlainObject(v) ? keysToCamel(v) : v;
    }
  }
  if (r.id !== undefined) r._id = r.id;
  return r;
}

function toBindable(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v instanceof Date ? v.toISOString() : v;
}

function keysToSnake(obj) {
  if (!isPlainObject(obj)) return obj;
  const r = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_id') { r.id = toBindable(v); continue; }
    r[toSnake(k)] = toBindable(v);
  }
  return r;
}

function buildWhere(filter) {
  if (!filter || Object.keys(filter).length === 0) return { sql: '', params: [] };

  const conds = [];
  const params = [];

  // inner helper for sub-conditions (returns just the conditions, no WHERE/AND prefix)
  function innerCond(f) {
    const result = buildWhere(f);
    return { sql: result.sql.replace(/^WHERE /, ''), params: result.params };
  }

for (const [key, value] of Object.entries(filter)) {
      if (key === '$or') {
        const parts = value.map((sub) => {
          const { sql: s, params: p } = innerCond(sub);
          return { s, p };
        });
        conds.push('(' + parts.map((x) => x.s).join(' OR ') + ')');
        for (const p of parts) params.push(...p.p);
        continue;
      }

      if (key === '$and') {
        const parts = value.map((sub) => {
          const { sql: s, params: p } = innerCond(sub);
          return { s, p };
        });
        conds.push('(' + parts.map((x) => x.s).join(' AND ') + ')');
        for (const p of parts) params.push(...p.p);
        continue;
      }

    const col = key === '_id' ? 'id' : toSnake(key);

    if (isPlainObject(value)) {
      for (const [op, opVal] of Object.entries(value)) {
        switch (op) {
          case '$gt':
            conds.push(`${col} > ?`);
            params.push(toBindable(opVal));
            break;
          case '$gte':
            conds.push(`${col} >= ?`);
            params.push(toBindable(opVal));
            break;
          case '$lt':
            conds.push(`${col} < ?`);
            params.push(toBindable(opVal));
            break;
          case '$lte':
            conds.push(`${col} <= ?`);
            params.push(toBindable(opVal));
            break;
          case '$ne':
            conds.push(`${col} != ?`);
            params.push(toBindable(opVal));
            break;
          case '$in': {
            const pl = opVal.map(() => '?').join(',');
            conds.push(`${col} IN (${pl})`);
            params.push(...opVal.map(toBindable));
            break;
          }
          case '$nin': {
            const pl = opVal.map(() => '?').join(',');
            conds.push(`${col} NOT IN (${pl})`);
            params.push(...opVal.map(toBindable));
            break;
          }
          case '$exists':
            conds.push(opVal ? `${col} IS NOT NULL` : `${col} IS NULL`);
            break;
          default:
            throw new Error(`Unsupported operator: ${op}`);
        }
      }
    } else {
      conds.push(`${col} = ?`);
      params.push(toBindable(value));
    }
  }

  return { sql: 'WHERE ' + conds.join(' AND '), params };
}

function buildSelect(projection) {
  if (!projection || Object.keys(projection).length === 0) return '*';
  const cols = Object.entries(projection)
    .filter(([, v]) => v === 1 || v === true)
    .map(([k]) => (k === '_id' ? 'id' : toSnake(k)));
  return cols.length > 0 ? cols.join(', ') : '*';
}

function buildUpdate(update) {
  const clauses = [];
  const params = [];

  for (const [key, value] of Object.entries(update)) {
    if (key === '$set') {
      for (const [k, v] of Object.entries(value)) {
        clauses.push(`${toSnake(k)} = ?`);
        params.push(toBindable(v));
      }
    } else if (key === '$inc') {
      for (const [k, v] of Object.entries(value)) {
        clauses.push(`${toSnake(k)} = ${toSnake(k)} + ?`);
        params.push(v);
      }
    } else if (key === '$unset') {
      for (const [k] of Object.entries(value)) {
        clauses.push(`${toSnake(k)} = NULL`);
      }
    } else {
      clauses.push(`${toSnake(key)} = ?`);
      params.push(toBindable(value));
    }
  }

  return { sql: clauses.join(', '), params };
}

class Doc {
  constructor(table, data, pkField) {
    this._table = table;
    this._pkField = pkField;
    this._origData = { ...data };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'id') this._id = v;
      this[k] = v;
    }
  }

  save() {
    const changes = {};
    for (const [k, v] of Object.entries(this)) {
      if (k.startsWith('_')) continue;
      if (v !== undefined && JSON.stringify(v) !== JSON.stringify(this._origData[k])) {
        changes[k] = v;
      }
    }
    if (Object.keys(changes).length === 0) return this;

    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(changes)) {
      cols.push(`${toSnake(k)} = ?`);
      vals.push(toBindable(v));
    }
    const pkCamel = this._pkField === 'id' ? 'id' : (this._pkField === 'code' ? 'code' : toCamel(this._pkField));
    vals.push(this[pkCamel]);

    const db = getDb();
    const pkCol = this._pkField === 'id' ? 'id' : (this._pkField === 'code' ? 'code' : toSnake(this._pkField));
    db.prepare(`UPDATE ${this._table} SET ${cols.join(', ')} WHERE ${pkCol} = ?`).run(...vals);
    this._origData = { ...this._origData, ...changes };
    return this;
  }

  toJSON() {
    const r = {};
    for (const [k, v] of Object.entries(this)) {
      if (!k.startsWith('_') && v !== undefined) r[k] = v;
    }
    return r;
  }
}

class SingleQuery {
  constructor(table, filter, projection, pkField) {
    this._table = table;
    this._filter = filter;
    this._projection = projection;
    this._pkField = pkField || 'id';
    this._isLean = false;
  }

  lean() {
    this._isLean = true;
    return this;
  }

  then(resolve, reject) {
    try {
      return Promise.resolve(this._exec()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).catch(reject);
    }
  }

  _exec() {
    const select = buildSelect(this._projection);
    const { sql: whereSql, params } = buildWhere(this._filter);
    const db = getDb();
    const row = db.prepare(`SELECT ${select} FROM ${this._table} ${whereSql} LIMIT 1`).get(...params);
    if (!row) return null;
    const camel = keysToCamel(row);
    return this._isLean ? camel : new Doc(this._table, camel, this._pkField);
  }
}

class MultiQuery {
  constructor(table, filter, projection, pkField) {
    this._table = table;
    this._filter = filter || {};
    this._projection = projection || {};
    this._pkField = pkField || 'id';
    this._sortSpec = null;
    this._limitVal = null;
  }

  sort(spec) {
    this._sortSpec = spec;
    return this;
  }

  limit(n) {
    this._limitVal = n;
    return this;
  }

  lean() {
    return this;
  }

  then(resolve, reject) {
    try {
      return Promise.resolve(this._exec()).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).catch(reject);
    }
  }

  _exec() {
    const select = buildSelect(this._projection);
    const { sql: whereSql, params } = buildWhere(this._filter);
    const db = getDb();
    let sql = `SELECT ${select} FROM ${this._table} ${whereSql}`;

    if (this._sortSpec) {
      const cols = Object.entries(this._sortSpec)
        .map(([k, v]) => `${toSnake(k)} ${v === -1 ? 'DESC' : 'ASC'}`)
        .join(', ');
      sql += ` ORDER BY ${cols}`;
    }

    if (this._limitVal) sql += ` LIMIT ${this._limitVal}`;

    return db.prepare(sql).all(...params).map((r) => keysToCamel(r));
  }
}

const ALLOWED_TABLES = new Set([
  'accounts', 'sessions', 'commits', 'workspaces', 'subscriptions',
  'devices', 'credentials', 'quick_connect_codes', 'compaction_locks',
  'collaboration_keys', 'note_invitations', 'email_aliases',
  'webauthn_challenges', 'workspace_members', 'workspace_invites',
  'sso_configs', 'sso_oidc_states', 'audit_logs', 'yjs_doc_updates',
  'vault_key_params', 'note_invite_links',
  // New org tables
  'organizations', 'org_members', 'org_subscriptions',
]);

function validateTableName(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

function createModel(table, pkField) {
  validateTableName(table);

  const M = {
    _table: table,
    _pkField: pkField || 'id',

    findById(id, projection) {
      return new SingleQuery(table, { _id: id }, projection, pkField);
    },

    findOne(filter, projection) {
      return new SingleQuery(table, filter, projection, pkField);
    },

    find(filter, projection) {
      return new MultiQuery(table, filter, projection, pkField);
    },

    create(data) {
      const d = keysToSnake(data);
      if (!d.id && (pkField === 'id' || !pkField)) d.id = crypto.randomUUID();
      if (d.created_at === undefined) d.created_at = new Date().toISOString();

      const cols = Object.keys(d).join(', ');
      const ph = Object.keys(d).map(() => '?').join(', ');
      const vals = Object.values(d).map(toBindable);
      const db = getDb();
      db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${ph})`).run(...vals);

      return new Doc(table, keysToCamel(d), pkField || 'id');
    },

    updateOne(filter, update) {
      const { sql: setSql, params: setParams } = buildUpdate(update);
      const { sql: whereSql, params: whereParams } = buildWhere(filter);
      const db = getDb();
      const r = db.prepare(`UPDATE ${table} SET ${setSql} ${whereSql}`).run(...setParams, ...whereParams);
      return { modifiedCount: r.changes };
    },

    updateMany(filter, update) {
      return this.updateOne(filter, update);
    },

    deleteOne(filter) {
      const { sql: whereSql, params } = buildWhere(filter);
      const db = getDb();
      const r = db.prepare(`DELETE FROM ${table} ${whereSql}`).run(...params);
      return { deletedCount: r.changes };
    },

    deleteMany(filter) {
      const { sql: whereSql, params } = buildWhere(filter);
      const db = getDb();
      const r = db.prepare(`DELETE FROM ${table} ${whereSql}`).run(...params);
      return { deletedCount: r.changes };
    },

    countDocuments(filter) {
      const { sql: whereSql, params } = buildWhere(filter);
      const db = getDb();
      const r = db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${whereSql}`).get(...params);
      return r.count;
    },

    findOneAndUpdate(filter, update, options) {
      const opts = options || {};
      const db = getDb();
      const { sql: whereSql, params: whereParams } = buildWhere(filter);
      const whereClause = whereSql;

      if (opts.upsert) {
        const existing = db.prepare(`SELECT * FROM ${table} ${whereClause} LIMIT 1`).get(...whereParams);
        if (!existing) {
          const insertData = {};
          for (const [k, v] of Object.entries(filter)) {
            if (k === '$or' || k === '$and' || isPlainObject(v)) continue;
            const col = k === '_id' ? 'id' : toSnake(k);
            insertData[col] = v instanceof Date ? v.toISOString() : v;
          }
          if (update.$set) {
            for (const [k, v] of Object.entries(update.$set)) {
              insertData[toSnake(k)] = v instanceof Date ? v.toISOString() : v;
            }
          } else {
            // Flat update object (e.g. { label, lastSeen }) — treat as $set
            for (const [k, v] of Object.entries(update)) {
              if (k === '$or' || k === '$and' || k === '$inc' || isPlainObject(v)) continue;
              insertData[toSnake(k)] = v instanceof Date ? v.toISOString() : v;
            }
          }
          if (update.$inc) {
            for (const [k, v] of Object.entries(update.$inc)) {
              if (insertData[toSnake(k)] === undefined) {
                insertData[toSnake(k)] = v >= 0 ? v : 0;
              }
            }
          }
            if (!insertData.id && (pkField === 'id' || !pkField)) insertData.id = crypto.randomUUID();
          if (insertData.created_at === undefined) insertData.created_at = new Date().toISOString();

          const cols = Object.keys(insertData).join(', ');
          const ph = Object.keys(insertData).map(() => '?').join(', ');
          const vals = Object.values(insertData).map(toBindable);
          try {
            db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${ph})`).run(...vals);
          } catch (e) {
            if (e.message.includes('UNIQUE constraint')) return null;
            throw e;
          }

          if (opts.new) {
            const inserted = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(insertData.id);
            return inserted ? new Doc(table, keysToCamel(inserted), pkField || 'id') : null;
          }
          return null;
        }
      }

      const existing = db.prepare(`SELECT * FROM ${table} ${whereClause} LIMIT 1`).get(...whereParams);
      if (!existing) return null;

      const { sql: setSql, params: setParams } = buildUpdate(update);
      db.prepare(`UPDATE ${table} SET ${setSql} ${whereClause}`).run(...setParams, ...whereParams);

      if (opts.new) {
        const updated = db.prepare(`SELECT * FROM ${table} ${whereClause} LIMIT 1`).get(...whereParams);
        return updated ? new Doc(table, keysToCamel(updated), pkField || 'id') : null;
      }

      return new Doc(table, keysToCamel(existing), pkField || 'id');
    },

    findOneAndDelete(filter) {
      const { sql: whereSql, params } = buildWhere(filter);
      const whereClause = whereSql;
      const db = getDb();
      const existing = db.prepare(`SELECT * FROM ${table} ${whereClause} LIMIT 1`).get(...params);
      if (!existing) return null;
      db.prepare(`DELETE FROM ${table} ${whereClause}`).run(...params);
      return keysToCamel(existing);
    },
  };

  return M;
}

const Account = createModel('accounts');
const Session = createModel('sessions', 'id_hash');
const CommitMeta = createModel('commits');
const Device = createModel('devices');
const Subscription = createModel('subscriptions');
const Credential = createModel('credentials');
const QuickConnectCode = createModel('quick_connect_codes', 'code');
const CompactionLock = createModel('compaction_locks');
const CollaborationKey = createModel('collaboration_keys');
const NoteInvitation = createModel('note_invitations', '_composite');
const Workspace = createModel('workspaces');
const WorkspaceMember = createModel('workspace_members', '_composite');
const WorkspaceInvite = createModel('workspace_invites', 'token_hash');
const AuditLog = createModel('audit_logs');
const SsoConfig = createModel('sso_configs');
const SsoOidcState = createModel('sso_oidc_states', 'state');
const EmailAlias = createModel('email_aliases', 'alias');
const WebAuthnChallenge = createModel('webauthn_challenges');
const YjsDocUpdate = createModel('yjs_doc_updates');
const VaultKeyParams = createModel('vault_key_params');
const NoteInviteLink = createModel('note_invite_links');
const Organization = createModel('organizations');
const OrgMember = createModel('org_members', '_composite');
const OrgSubscription = createModel('org_subscriptions');

module.exports = {
  Account, Session, CommitMeta, Device, Subscription,
  Credential, QuickConnectCode, CompactionLock,
  CollaborationKey, NoteInvitation,
  Workspace, WorkspaceMember, WorkspaceInvite,
  AuditLog, SsoConfig, SsoOidcState, EmailAlias, WebAuthnChallenge,
  YjsDocUpdate, VaultKeyParams, NoteInviteLink,
  Organization, OrgMember, OrgSubscription,
};
