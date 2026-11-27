const logs = require('./logService');

// Perfil 'pasajes' (Clientes.tipoNegocio): negocios que venden pasajes de micro y
// ya tienen su propio sistema (hoy Aguirre SRL). El bot NO lee ni escribe la base
// de ese sistema: le pregunta a su API (Clientes.apiExternaUrl, Bearer
// apiExternaToken) y el sistema aplica sus reglas (asientos libres, bloqueo por
// viaje, a quién le toca la venta). Endpoints (todos POST + JSON):
//   /viajes { texto?, fechaDesde?, fechaHasta? }  viajes con lugares libres y precios
//   /asientos { idViaje }                         asientos libres (cama / semicama)
//   /promociones {}                               precios promo efectivo
//   /reservar { telefonoWhatsApp, userIdChat, nombreContacto, dniContacto, observaciones, asientos: [...] }
// Después de reservar, el código (no Claude) manda MENSAJE_DERIVACION y pausa el
// chat: sigue una persona del negocio (la que el sistema asignó), que cobra y
// carga el pasaje. El sistema reactiva el bot en el chat al vender o liberar.

const TIMEOUT_MS = 12000;
const MAX_RESULTADO = 6000; // lo que se le pasa a Claude de cada respuesta (tokens)

const MENSAJE_DERIVACION = '¡Perfecto, {nombre}! Ya te guardé el lugar para el viaje a {destino} del {fecha} ({asientos}). Ahora te paso con {usuario}, que te arma todo para el pago. En un ratito te escribe 🙌';
// Sin nadie asignado (fuera de horario): no se promete un nombre.
const MENSAJE_DERIVACION_SIN_ASIGNAR = '¡Perfecto, {nombre}! Ya te guardé el lugar para el viaje a {destino} del {fecha} ({asientos}). En un ratito te escribe alguien del equipo para armar todo el pago 🙌';

const tools = [
  {
    name: 'buscar_viajes',
    description: 'Busca los viajes disponibles en el sistema (desde hoy) con su fecha, horario, lugares libres y precios. Llamala SIEMPRE antes de hablar de horarios, fechas, disponibilidad o precios: nunca los respondas de memoria. "texto" filtra por destino, origen o nombre del viaje (ej: "salta", "buenos aires"); vacío trae todos. Por defecto busca 7 días: si piden otra fecha, pasá fechaDesde y fechaHasta (AAAA-MM-DD, como mucho 31 días). Cada viaje es UN sentido (Ida o Vuelta): para ida y vuelta buscá los dos.',
    input_schema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Destino u origen, ej: "salta"' },
        fechaDesde: { type: 'string', description: 'AAAA-MM-DD' },
        fechaHasta: { type: 'string', description: 'AAAA-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'ver_asientos',
    description: 'Devuelve los asientos LIBRES de un viaje (número y si es cama o semicama) y sus precios. Usala antes de ofrecer o reservar asientos puntuales.',
    input_schema: {
      type: 'object',
      properties: { idViaje: { type: 'integer', description: 'idViaje tal como lo devolvió buscar_viajes' } },
      required: ['idViaje'],
    },
  },
  {
    name: 'ver_promociones',
    description: 'Promociones vigentes del sistema (hoy: precio promo efectivo de ida y vuelta de los próximos viajes). Usala cuando pregunten por promociones, descuentos u ofertas.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'reservar_pasajes',
    description: 'Reserva los asientos en el sistema y le pasa la venta a una persona del equipo, que cobra y emite el pasaje. Llamala ÚNICAMENTE cuando el cliente confirmó explícitamente el resumen (viaje/s, asientos y pasajeros con nombre y DNI) en su último mensaje. Nunca la llames en el mismo mensaje en que proponés el resumen. Después de llamarla no escribas nada: el sistema le manda al cliente el mensaje de que ya tiene el lugar y lo atiende una persona.',
    input_schema: {
      type: 'object',
      properties: {
        nombreContacto: { type: 'string', description: 'Nombre de quien escribe (el que compra)' },
        dniContacto: { type: 'string', description: 'DNI de quien compra, si lo dio' },
        observaciones: { type: 'string', description: 'Algo que el equipo tenga que saber (ej: viaja con un bebé, quiere pagar en efectivo)' },
        asientos: {
          type: 'array',
          description: 'Un elemento por asiento y por viaje (ida y vuelta de una persona = 2 elementos)',
          items: {
            type: 'object',
            properties: {
              idViaje: { type: 'integer' },
              numeroAsiento: { type: 'integer' },
              nombrePasajero: { type: 'string', description: 'Nombre y apellido de quien viaja en ese asiento' },
              dniPasajero: { type: 'string', description: 'DNI de quien viaja' },
            },
            required: ['idViaje', 'numeroAsiento', 'nombrePasajero', 'dniPasajero'],
          },
        },
      },
      required: ['nombreContacto', 'asientos'],
    },
  },
];

const NOMBRES = new Set(tools.map(t => t.name));

async function llamarApi(negocio, ruta, cuerpo) {
  if (!negocio.apiExternaUrl || !negocio.apiExternaToken) throw new Error('El Cliente no tiene configurada la API externa (apiExternaUrl / apiExternaToken)');
  const res = await fetch(`${negocio.apiExternaUrl}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${negocio.apiExternaToken}` },
    body: JSON.stringify(cuerpo ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const texto = await res.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* se informa abajo */ }
  if (!res.ok || !datos) throw new Error(`API externa ${ruta}: HTTP ${res.status} ${texto.slice(0, 200)}`);
  return datos;
}

function recortar(texto) {
  return texto.length > MAX_RESULTADO ? `${texto.slice(0, MAX_RESULTADO)}…(recortado: pedí más detalle o una fecha más corta)` : texto;
}

function errorInterno(que, err) {
  console.error(`[pasajes] Error al ${que}:`, err.message);
  return `Error: no se pudo ${que} en este momento. Pedile disculpas al cliente y ofrecele que alguien del equipo lo contacte (escalar_a_humano).`;
}

const texto = (v, max) => String(v ?? '').trim().slice(0, max);

// Devuelve el texto para Claude. Si la reserva salió, deja los datos en turno.derivacion.
async function ejecutar(negocio, clienteId, userId, block, turno) {
  const input = block.input || {};

  if (block.name === 'buscar_viajes') {
    try {
      const r = await llamarApi(negocio, '/viajes', { texto: texto(input.texto, 60), fechaDesde: texto(input.fechaDesde, 10), fechaHasta: texto(input.fechaHasta, 10) });
      if (!r.viajes?.length) return 'No hay viajes disponibles con ese filtro y en esas fechas. Probá otras fechas o sin filtro.';
      return recortar(JSON.stringify(r.viajes) + (r.hayMas ? '\n(Hay más viajes: estos son los primeros. Si no está el que busca, pedí la fecha o el destino.)' : ''));
    } catch (err) {
      return errorInterno('consultar los viajes', err);
    }
  }

  if (block.name === 'ver_asientos') {
    const idViaje = Number(input.idViaje);
    if (!Number.isInteger(idViaje) || idViaje <= 0) return 'Error: idViaje inválido. Usá el idViaje que devolvió buscar_viajes.';
    try {
      const r = await llamarApi(negocio, '/asientos', { idViaje });
      if (!r.ok) return 'Ese viaje ya no está disponible para reservar. Buscá los viajes de nuevo.';
      return recortar(JSON.stringify({ viaje: r.viaje, libres: r.libres }));
    } catch (err) {
      return errorInterno('consultar los asientos', err);
    }
  }

  if (block.name === 'ver_promociones') {
    try {
      const r = await llamarApi(negocio, '/promociones', {});
      if (!r.promociones?.length) return 'No hay promociones cargadas en el sistema para los próximos viajes.';
      return recortar(JSON.stringify({ promociones: r.promociones, nota: r.nota }));
    } catch (err) {
      return errorInterno('consultar las promociones', err);
    }
  }

  if (block.name === 'reservar_pasajes') {
    if (turno.derivacion) return 'Ya reservaste en esta respuesta: no reserves otra vez.';
    const asientos = Array.isArray(input.asientos) ? input.asientos.slice(0, 10) : [];
    const invalidos = asientos.filter(a => !Number.isInteger(Number(a?.idViaje)) || !Number.isInteger(Number(a?.numeroAsiento)) || !texto(a?.nombrePasajero, 150));
    if (!asientos.length || invalidos.length) return 'Error: cada asiento necesita idViaje, numeroAsiento y el nombre del pasajero. Pedile al cliente lo que falte antes de reservar.';
    try {
      const r = await llamarApi(negocio, '/reservar', {
        telefonoWhatsApp: userId,
        userIdChat: userId,
        nombreContacto: texto(input.nombreContacto, 150),
        dniContacto: texto(input.dniContacto, 20),
        observaciones: texto(input.observaciones, 500),
        asientos: asientos.map(a => ({
          idViaje: Number(a.idViaje),
          numeroAsiento: Number(a.numeroAsiento),
          nombrePasajero: texto(a.nombrePasajero, 150),
          dniPasajero: texto(a.dniPasajero, 20),
        })),
      });
      if (!r.ok) return `No se pudo reservar: ${String(r.error || 'el sistema lo rechazó').replace(/\.+$/, '')}. Explicale al cliente y ofrecele otra opción (otro asiento u otro viaje).`;
      turno.derivacion = { ...r, nombreContacto: texto(input.nombreContacto, 150) };
      logs.info('reserva_bot_creada', { clienteId, userId, detalle: { idReserva: r.idReserva, asignadaA: r.asignadaA, estado: r.estado, asientos: r.asientos } });
      return `Reserva N° ${r.idReserva} creada. No escribas nada más: el sistema le avisa al cliente.`;
    } catch (err) {
      return errorInterno('reservar los asientos', err);
    }
  }

  return `Tool desconocida: ${block.name}`;
}

// "5/12/2026" -> "viernes 5/12"
function fechaLinda(ddmmaaaa) {
  const [d, m, a] = String(ddmmaaaa || '').split('/').map(Number);
  if (!d || !m || !a) return ddmmaaaa || '';
  const dia = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${dia} ${d}/${m}`;
}

// "SAN SALVADOR DE JUJUY" -> "San Salvador de Jujuy" (los destinos vienen en mayúsculas del sistema)
function nombrePropio(texto) {
  const chicas = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
  return String(texto || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((p, i) => (i > 0 && chicas.has(p) ? p : p[0].toUpperCase() + p.slice(1))).join(' ');
}

function listaAsientos(numeros) {
  if (numeros.length === 1) return `asiento ${numeros[0]}`;
  return `asientos ${numeros.slice(0, -1).join(', ')} y ${numeros[numeros.length - 1]}`;
}

// Mensaje fijo de derivación con los datos reales de la reserva (lo arma el código, no Claude).
function mensajeDerivacion(negocio, derivacion) {
  const asientos = derivacion.asientos || [];
  const ida = asientos.find(a => a.tipoPasaje === 'Ida') || asientos[0] || {};
  const tramos = [...new Set(asientos.map(a => a.tipoPasaje))];
  const numeros = asientos.filter(a => a.tipoPasaje === (ida.tipoPasaje || 'Ida')).map(a => a.numeroAsiento);
  const textoAsientos = tramos.length > 1 ? `${listaAsientos(numeros)}, ida y vuelta` : listaAsientos(numeros);
  const nombre = String(derivacion.nombreContacto || '').trim().split(/\s+/)[0] || '';
  const asignada = Boolean(derivacion.asignadaA);
  const plantilla = negocio.mensajeDerivacion || (asignada ? MENSAJE_DERIVACION : MENSAJE_DERIVACION_SIN_ASIGNAR);
  const valores = {
    '{nombre}': nombre,
    '{destino}': nombrePropio(ida.destino),
    '{fecha}': fechaLinda(ida.fecha),
    '{horario}': ida.horario || '',
    '{asientos}': textoAsientos,
    '{usuario}': asignada ? derivacion.asignadaA : 'alguien del equipo',
  };
  let mensaje = plantilla;
  for (const [variable, valor] of Object.entries(valores)) mensaje = mensaje.split(variable).join(valor);
  // Sin nombre no queda "¡Perfecto, !".
  return mensaje.replace(/,\s*!/g, '!').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { tools, NOMBRES, ejecutar, mensajeDerivacion, llamarApi, MENSAJE_DERIVACION };
