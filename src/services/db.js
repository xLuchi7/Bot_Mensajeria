const sql = require('mssql');
const config = require('../config');

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = sql
      .connect({
        server: config.db.server,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
        port: config.db.port,
        options: {
          encrypt: true, // requerido por Azure SQL
          trustServerCertificate: false,
        },
      })
      .then(pool => {
        // Si la conexión se cae más tarde (ej: la base se reinicia), que el
        // próximo getPool() reconecte de cero en vez de seguir devolviendo
        // este pool roto.
        pool.on('error', err => {
          console.error('[db] Error en el pool de conexión, se reintentará en el próximo uso:', err.message);
          poolPromise = null;
        });
        return pool;
      })
      .catch(err => {
        // Si la conexión inicial falla (ej: la base estaba "dormida" y no
        // respondió a tiempo), no dejamos la promesa rota cacheada para
        // siempre -- si quedara cacheada, todos los mensajes siguientes
        // repetirían el mismo error sin volver a intentar conectar, hasta
        // que alguien reinicie el proceso a mano.
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { getPool, sql };
