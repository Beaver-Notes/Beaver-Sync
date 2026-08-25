'use strict';

const crypto = require('crypto');
const { query } = require('../db');

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

function buildWhere(filter, table, offset = 1) {
  if (!filter || Object.keys(filter).length === 0) return { sql: '', params: [], nextIndex: offset };

  const conds = [];
  const params = [];
  let idx = offset;

  // inner helper for sub-conditions (returns just the conditions, no WHERE/AND prefix)
  function innerCond(f) {
    const result = buildWhere(f, table, idx);
    idx = result.nextIndex;
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

    const col = toColumn(table, key);

    if (isPlainObject(value)) {
      for (const [op, opVal] of Object.entries(value)) {
        switch (op) {
          case '$gt':
            conds.push(`${col} > $${idx++}`);
            params.push(toBindable(opVal));
            break;
          case '$gte':
            conds.push(`${col} >= $${idx++}`);
            params.push(toBindable(opVal));
            break;
          case '$lt':
            conds.push(`${col} < $${idx++}`);
            params.push(toBindable(opVal));
            break;
          case '$lte':
            conds.push(`${col} <= $${idx++}`);
            params.push(toBindable(opVal));
            break;
          case '$ne':
            conds.push(`${col} != $${idx++}`);
            params.push(toBindable(opVal));
            break;
          case '$in': {
            const placeholders = opVal.map(() => `$${idx++}`).join(',');
            conds.push(`${col} IN (${placeholders})`);
            params.push(...opVal.map(toBindable));
            break;
          }
          // $nin / $exists removed — no callers; add when needed
          default:
            throw new Error(`Unsupported operator: ${op}`);
        }
      }
    } else {
      conds.push(`${col} = $${idx++}`);
      params.push(toBindable(value));
    }
  }

  return { sql: 'WHERE ' + conds.join(' AND '), params, nextIndex: idx };
}

function buildSelect(projection, table) {
  if (!projection || Object.keys(projection).length === 0) return '*';
  const cols = Object.entries(projection)
    .filter(([, v]) => v === 1 || v === true)
    .map(([k]) => toColumn(table, k));
  return cols.length > 0 ? cols.join(', ') : '*';
}

function buildUpdate(update, table) {
  const clauses = [];
  const params = [];
  let idx = 1;

  for (const [key, value] of Object.entries(update)) {
    if (key === '$set') {
      for (const [k, v] of Object.entries(value)) {
        clauses.push(`${toColumn(table, k)} = $${idx++}`);
        params.push(toBindable(v));
      }
    } else if (key === '$inc') {
      for (const [k, v] of Object.entries(value)) {
        const col = toColumn(table, k);
        clauses.push(`${col} = ${col} + $${idx++}`);
        params.push(v);
      }
    } else {
      clauses.push(`${toColumn(table, key)} = $${idx++}`);
      params.push(toBindable(value));
    }
  }

  return { sql: clauses.join(', '), params, nextIndex: idx };
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

  async save() {
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
    let idx = 1;
    for (const [k, v] of Object.entries(changes)) {
      cols.push(`${toColumn(this._table, k)} = $${idx++}`);
      vals.push(toBindable(v));
    }
    const pkCamel = this._pkField === 'id' ? 'id' : (this._pkField === 'code' ? 'code' : toCamel(this._pkField));
    vals.push(this[pkCamel]);

    const pkCol = this._pkField === 'id' ? 'id' : (this._pkField === 'code' ? 'code' : toSnake(this._pkField));
    await query(`UPDATE ${this._table} SET ${cols.join(', ')} WHERE ${pkCol} = $${idx}`, vals);
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
    return this._exec().then(resolve, reject);
  }

  async _exec() {
    const select = buildSelect(this._projection, this._table);
    const { sql: whereSql, params } = buildWhere(this._filter, this._table);
    const result = await query(`SELECT ${select} FROM ${this._table} ${whereSql} LIMIT 1`, params);
    const row = result.rows[0];
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
    return this._exec().then(resolve, reject);
  }

  async _exec() {
    const select = buildSelect(this._projection, this._table);
    const { sql: whereSql, params } = buildWhere(this._filter, this._table);
    let sql = `SELECT ${select} FROM ${this._table} ${whereSql}`;

    if (this._sortSpec) {
      const cols = Object.entries(this._sortSpec)
        .map(([k, v]) => `${toColumn(this._table, k)} ${v === -1 ? 'DESC' : 'ASC'}`)
        .join(', ');
      sql += ` ORDER BY ${cols}`;
    }

    if (this._limitVal !== null && this._limitVal !== undefined) {
      const limit = Number(this._limitVal);
      if (Number.isInteger(limit) && limit > 0) {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(limit);
      }
    }

    const result = await query(sql, params);
    return result.rows.map((r) => keysToCamel(r));
  }
}

const ALLOWED_TABLES = new Set([
  'accounts', 'sessions', 'commits', 'workspaces', 'subscriptions',
  'devices', 'credentials', 'quick_connect_codes', 'compaction_locks',
  'note_keys', 'workspace_keys', 'org_keys',
  'note_invitations', 'email_aliases',
  'webauthn_challenges', 'workspace_members', 'workspace_invites',
  'sso_configs', 'sso_oidc_states', 'audit_logs', 'yjs_doc_updates',
  'vault_key_params', 'note_invite_links',
  'note_comments',
  // New org tables
  'organizations', 'org_members', 'org_subscriptions', 'org_invites',
]);

function validateTableName(table) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

// Mirrors src/db/schema.postgres.sql (+ ALTER TABLE additions). Keep in sync.
const ALLOWED_COLUMNS = {
  accounts: new Set(['id', 'username', 'email_hmac', 'email_encrypted', 'kem_public_key',
    'device_keys', 'password_hash', 'recovery_key_hash', 'failed_login_attempts',
    'locked_until', 'kdf_salt', 'wrapped_aek', 'created_at', 'jwt_revoked_at']),
  sessions: new Set(['id_hash', 'account_id', 'workspace_id', 'device_label', 'device_id',
    'device_fingerprint_hash', 'ip_subnet', 'expires_at', 'last_seen_at', 'revoked', 'created_at']),
  commits: new Set(['commit_id', 'account_id', 'device_id', 'note_id_hash', 'workspace_id',
    'payload_encrypted', 'clock', 'ts', 'size_bytes', 'created_at']),
  workspaces: new Set(['id', 'name_encrypted', 'owner_id', 'org_id', 'vault_wrapped_keys',
    'storage_used_bytes', 'data_residency', 'emoji', 'color', 'created_at']),
  subscriptions: new Set(['id', 'account_id', 'plan', 'status', 'provider', 'renews_at',
    'stripe_customer_id', 'stripe_subscription_id', 'apple_original_transaction_id',
    'google_purchase_token', 'storage_quota_bytes', 'storage_used_bytes', 'created_at']),
  devices: new Set(['id', 'account_id', 'device_id', 'label', 'last_seen', 'created_at']),
  credentials: new Set(['id', 'account_id', 'credential_id', 'public_key', 'sign_count',
    'device_label', 'created_at']),
  quick_connect_codes: new Set(['code', 'secret', 'authorized', 'payload', 'expires_at', 'created_at']),
  compaction_locks: new Set(['id', 'locked_at', 'expires_at', 'created_at']),
  note_keys: new Set(['note_id', 'user_id', 'device_id', 'wrapped_key', 'created_at']),
  workspace_keys: new Set(['workspace_id', 'user_id', 'wrapped_key', 'created_at']),
  org_keys: new Set(['org_id', 'user_id', 'wrapped_key', 'created_at']),
  note_invitations: new Set(['note_id', 'user_id', 'invited_by', 'role', 'created_at']),
  email_aliases: new Set(['alias', 'account_id', 'email_encrypted', 'created_at', 'expires_at']),
  webauthn_challenges: new Set(['id', 'email_hmac', 'challenge', 'expires_at', 'created_at']),
  workspace_members: new Set(['workspace_id', 'account_id', 'role', 'created_at']),
  workspace_invites: new Set(['token_hash', 'workspace_id', 'role', 'require_approval',
    'expires_at', 'max_uses', 'used_count', 'created_at']),
  sso_configs: new Set(['id', 'workspace_id', 'protocol', 'slug', 'idp_entity_id', 'idp_sso_url',
    'idp_cert_encrypted', 'oidc_issuer', 'oidc_client_id', 'oidc_client_secret_encrypted',
    'sp_cert', 'sp_private_key_encrypted', 'allowed_email_domains', 'created_at']),
  sso_oidc_states: new Set(['state', 'code_verifier', 'nonce', 'slug', 'created_at']),
  audit_logs: new Set(['id', 'account_id_hash', 'workspace_id', 'action', 'metadata_encrypted',
    'ip_subnet', 'created_at']),
  yjs_doc_updates: new Set(['id', 'workspace_id', 'note_id', 'update_data', 'update_encrypted',
    'device_id', 'clock', 'ts', 'created_at']),
  vault_key_params: new Set(['id', 'workspace_id', 'owner_id', 'passphrase_hash', 'proof_version',
    'key_params_blob', 'created_at', 'updated_at']),
  note_invite_links: new Set(['id', 'note_id', 'created_by', 'token_hash', 'role',
    'require_approval', 'expires_at', 'revoked', 'created_at']),
  note_comments: new Set(['id', 'note_id', 'thread_id', 'author_id', 'content_encrypted',
    'content_iv', 'anchor_from', 'anchor_to', 'resolved', 'parent_id', 'mentions',
    'created_at', 'updated_at']),
  organizations: new Set(['id', 'name_encrypted', 'slug', 'created_at']),
  org_members: new Set(['org_id', 'account_id', 'role', 'created_at']),
  org_subscriptions: new Set(['id', 'org_id', 'plan', 'status', 'seats', 'provider', 'renews_at',
    'stripe_customer_id', 'stripe_subscription_id', 'storage_quota_bytes', 'storage_used_bytes',
    'created_at']),
  org_invites: new Set(['id', 'org_id', 'created_by', 'token_hash', 'role', 'require_approval',
    'approved_by', 'max_uses', 'used_count', 'expires_at', 'revoked', 'created_at']),
};

function assertColumn(table, col) {
  const allowed = ALLOWED_COLUMNS[table];
  if (!allowed || !allowed.has(col)) {
    throw new Error(`Invalid column "${col}" for table "${table}"`);
  }
}

// Caller-supplied key (_id or camelCase) -> validated snake_case column.
function toColumn(table, key) {
  const col = key === '_id' ? 'id' : toSnake(key);
  assertColumn(table, col);
  return col;
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

    async create(data) {
      const d = keysToSnake(data);
      if (!d.id && (pkField === 'id' || !pkField)) d.id = crypto.randomUUID();
      if (d.created_at === undefined) d.created_at = new Date().toISOString();

      const cols = Object.keys(d).join(', ');
      const placeholders = Object.keys(d).map((_, i) => `$${i + 1}`).join(', ');
      const vals = Object.values(d).map(toBindable);
      for (const c of Object.keys(d)) assertColumn(table, c);

      await query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, vals);
      return new Doc(table, keysToCamel(d), pkField || 'id');
    },

    async updateOne(filter, update) {
      const { sql: setSql, params: setParams, nextIndex } = buildUpdate(update, table);
      const { sql: whereSql, params: whereParams } = buildWhere(filter, table, nextIndex);
      const result = await query(`UPDATE ${table} SET ${setSql} ${whereSql}`, [...setParams, ...whereParams]);
      return { modifiedCount: result.rowCount };
    },

    updateMany(filter, update) {
      return this.updateOne(filter, update);
    },

    async deleteOne(filter) {
      const { sql: whereSql, params } = buildWhere(filter, table);
      const result = await query(`DELETE FROM ${table} ${whereSql}`, params);
      return { deletedCount: result.rowCount };
    },

    deleteMany(filter) {
      return this.deleteOne(filter);
    },

    async countDocuments(filter) {
      const { sql: whereSql, params } = buildWhere(filter, table);
      const result = await query(`SELECT COUNT(*) AS count FROM ${table} ${whereSql}`, params);
      return Number(result.rows[0].count);
    },

    async findOneAndUpdate(filter, update, options) {
      const opts = options || {};
      const { sql: whereSql, params: whereParams } = buildWhere(filter, table);
      const whereClause = whereSql;

      if (opts.upsert) {
        const existingResult = await query(`SELECT * FROM ${table} ${whereClause} LIMIT 1`, whereParams);
        const existing = existingResult.rows[0];
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
          for (const c of Object.keys(insertData)) assertColumn(table, c);

          const cols = Object.keys(insertData).join(', ');
          const placeholders = Object.keys(insertData).map((_, i) => `$${i + 1}`).join(', ');
          const vals = Object.values(insertData).map(toBindable);
          try {
            await query(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, vals);
          } catch (e) {
            if (String(e.message ?? '').toLowerCase().includes('unique')) return null;
            throw e;
          }

          if (opts.new) {
            const insertedResult = await query(`SELECT * FROM ${table} WHERE id = $1`, [insertData.id]);
            const inserted = insertedResult.rows[0];
            return inserted ? new Doc(table, keysToCamel(inserted), pkField || 'id') : null;
          }
          return null;
        }
      }

      const existingResult = await query(`SELECT * FROM ${table} ${whereClause} LIMIT 1`, whereParams);
      const existing = existingResult.rows[0];
      if (!existing) return null;

      const { sql: setSql, params: setParams, nextIndex } = buildUpdate(update, table);
      const { sql: whereSqlOffset, params: whereParamsOffset } = buildWhere(filter, table, nextIndex);
      await query(`UPDATE ${table} SET ${setSql} ${whereSqlOffset}`, [...setParams, ...whereParamsOffset]);

      if (opts.new) {
        const updatedResult = await query(`SELECT * FROM ${table} ${whereClause} LIMIT 1`, whereParams);
        const updated = updatedResult.rows[0];
        return updated ? new Doc(table, keysToCamel(updated), pkField || 'id') : null;
      }

      return new Doc(table, keysToCamel(existing), pkField || 'id');
    },

    async findOneAndDelete(filter) {
      const { sql: whereSql, params } = buildWhere(filter, table);
      const whereClause = whereSql;
      const existingResult = await query(`SELECT * FROM ${table} ${whereClause} LIMIT 1`, params);
      const existing = existingResult.rows[0];
      if (!existing) return null;
      await query(`DELETE FROM ${table} ${whereClause}`, params);
      return keysToCamel(existing);
    },
  };

  return M;
}

const Account = createModel('accounts');
const Session = createModel('sessions', 'id_hash');
const CommitMeta = createModel('commits', 'commit_id');
const Device = createModel('devices');
const Subscription = createModel('subscriptions');
const Credential = createModel('credentials');
const QuickConnectCode = createModel('quick_connect_codes', 'code');
const CompactionLock = createModel('compaction_locks');
const NoteKey = createModel('note_keys', '_composite');
const WorkspaceKey = createModel('workspace_keys', '_composite');
const OrgKey = createModel('org_keys', '_composite');
const NoteInvitation = createModel('note_invitations', '_composite');
const Workspace = createModel('workspaces');
const WorkspaceMember = createModel('workspace_members', '_composite');
const WorkspaceInvite = createModel('workspace_invites', 'token_hash');
const AuditLog = createModel('audit_logs');
const SsoConfig = createModel('sso_configs');
const SsoOidcState = createModel('sso_oidc_states', 'state');
const EmailAlias = createModel('email_aliases', 'alias');
const WebAuthnChallenge = createModel('webauthn_challenges');
const VaultKeyParams = createModel('vault_key_params');
const NoteInviteLink = createModel('note_invite_links');
const NoteComment = createModel('note_comments');
const Organization = createModel('organizations');
const OrgMember = createModel('org_members', '_composite');
const OrgSubscription = createModel('org_subscriptions');
const OrgInvite = createModel('org_invites');

module.exports = {
  Account, Session, CommitMeta, Device, Subscription,
  Credential, QuickConnectCode, CompactionLock,
  NoteKey, WorkspaceKey, OrgKey,
  NoteInvitation,
  Workspace, WorkspaceMember, WorkspaceInvite,
  AuditLog, SsoConfig, SsoOidcState, EmailAlias, WebAuthnChallenge,
  VaultKeyParams, NoteInviteLink, NoteComment,
  Organization, OrgMember, OrgSubscription, OrgInvite,
};
