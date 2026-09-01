import initSqlJs from 'sql.js';

let sqlJsPromise;

async function getSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file) => new URL(`../../node_modules/sql.js/dist/${file}`, import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)),
    });
  }
  return sqlJsPromise;
}

function lastInsertId(database) {
  const result = database.exec('SELECT last_insert_rowid() AS id');
  return Number(result[0]?.values?.[0]?.[0] || 0);
}

export class SqlJsConnection {
  constructor(database) {
    this.database = database;
    this.transactionActive = false;
  }

  async open() {}

  async close() {
    this.database.close();
  }

  async query(statement, values = []) {
    const prepared = this.database.prepare(statement);
    try {
      prepared.bind(values);
      const rows = [];
      while (prepared.step()) rows.push(prepared.getAsObject());
      return { values: rows };
    } finally {
      prepared.free();
    }
  }

  async run(statement, values = [], transaction = true) {
    const ownsTransaction = transaction && !this.transactionActive;
    if (ownsTransaction) await this.beginTransaction();
    try {
      this.database.run(statement, values);
      const result = {
        changes: {
          changes: this.database.getRowsModified(),
          lastId: lastInsertId(this.database),
        },
      };
      if (ownsTransaction) await this.commitTransaction();
      return result;
    } catch (error) {
      if (ownsTransaction && this.transactionActive) await this.rollbackTransaction();
      throw error;
    }
  }

  async execute(statements, transaction = true) {
    const ownsTransaction = transaction && !this.transactionActive;
    if (ownsTransaction) await this.beginTransaction();
    try {
      this.database.run(statements);
      const result = { changes: { changes: this.database.getRowsModified() } };
      if (ownsTransaction) await this.commitTransaction();
      return result;
    } catch (error) {
      if (ownsTransaction && this.transactionActive) await this.rollbackTransaction();
      throw error;
    }
  }

  async beginTransaction() {
    if (this.transactionActive) throw new Error('nested transaction');
    this.database.run('BEGIN IMMEDIATE');
    this.transactionActive = true;
    return { changes: { changes: 0 } };
  }

  async commitTransaction() {
    if (!this.transactionActive) throw new Error('no active transaction');
    this.database.run('COMMIT');
    this.transactionActive = false;
    return { changes: { changes: 0 } };
  }

  async rollbackTransaction() {
    if (this.transactionActive) this.database.run('ROLLBACK');
    this.transactionActive = false;
    return { changes: { changes: 0 } };
  }
}

export async function createSqlJsConnection() {
  const SQL = await getSqlJs();
  return new SqlJsConnection(new SQL.Database());
}
