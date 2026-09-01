const nodemailer = require('nodemailer');
const config = require('../config');

// Gmail vía nodemailer, con una "Contraseña de aplicación" (no la contraseña
// normal de la cuenta -- Google no deja usar SMTP directo sin eso una vez que
// tenés verificación en 2 pasos activada, que es requisito para generarla).
// Alcanza para el volumen actual; si esto crece, conviene migrar a un servicio
// transaccional (Resend, etc.) por los límites de envío y entregabilidad de Gmail.
const transporter = config.email.gmailUser
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email.gmailUser,
        pass: config.email.gmailAppPassword,
      },
    })
  : null;

function formatearMoneda(monto) {
  return Number(monto).toLocaleString('es-AR');
}

// No bloquea la creación del pedido si falla el mail -- el pedido ya está
// creado y confirmado por WhatsApp de todas formas, esto es solo un aviso
// adicional. Se llama sin esperar (fire-and-forget) desde claudeService.
async function enviarNotificacionPedido(email, pedidoId, items, total) {
  if (!transporter) {
    console.warn('[email] GMAIL_USER no configurado, se omite la notificación del pedido.');
    return;
  }
  if (!email) return; // el Cliente no cargó su email todavía

  const filas = items
    .map(
      i => `
        <tr>
          <td style="padding: 6px 0;">${i.cantidad}x ${i.nombre}</td>
          <td style="padding: 6px 0; text-align: right;">$${formatearMoneda(i.precio * i.cantidad)}</td>
        </tr>`
    )
    .join('');

  const html = `
    <div style="font-family: sans-serif; color: #14172b; max-width: 480px;">
      <h2 style="margin-bottom: 0.25rem;">Nuevo pedido #${pedidoId}</h2>
      <p style="color: #6b7280; margin-top: 0;">Te llegó un pedido nuevo por WhatsApp.</p>
      <table style="width: 100%; border-collapse: collapse; margin: 1rem 0;">
        ${filas}
      </table>
      <p style="font-size: 1.05rem;"><strong>Total: $${formatearMoneda(total)}</strong></p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Bot Mensajería" <${config.email.gmailUser}>`,
      to: email,
      subject: `Nuevo pedido #${pedidoId}`,
      html,
    });
    console.log(`[email] Notificación del pedido #${pedidoId} enviada a ${email}`);
  } catch (err) {
    console.error('[email] Error al enviar notificación de pedido:', err.message);
  }
}

module.exports = { enviarNotificacionPedido };
