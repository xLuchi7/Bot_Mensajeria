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

/**
 * Ejecuta un stored procedure. Todo el SQL del bot vive en procedures
 * (D:\SQL Scripts\Bot_Mensajeria.sql); acá solo se los llama.
 * @param {string} procedure  ej. 'dbo.usp_Bot_ArticulosBuscar'
 * @param {Record<string, [any, any]>} params  { nombre: [tipoMssql, valor] }
 * @returns {Promise<import('mssql').IProcedureResult<any>>}
 */
async function ejecutar(procedure, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [nombre, [tipo, valor]] of Object.entries(params)) {
    request.input(nombre, tipo, valor === undefined ? null : valor);
  }
  return request.execute(procedure);
}

module.exports = { getPool, ejecutar, sql };
