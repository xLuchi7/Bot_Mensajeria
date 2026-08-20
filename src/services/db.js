const sql = require('mssql');
const config = require('../config');

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect({
      server: config.db.server,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      port: config.db.port,
      options: {
        encrypt: true, // requerido por Azure SQL
        trustServerCertificate: false,
      },
    });
  }
  return poolPromise;
}

module.exports = { getPool, sql };
