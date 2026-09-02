const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');

const LOGO_PATH = path.join(__dirname, '../../assets/logo.png');

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

// Tabla clásica con estilos inline: es lo único que Outlook/Gmail/etc. renderizan
// de forma consistente entre sí, a diferencia de flexbox/grid en el resto de la app.
function armarHtml(pedidoId, items, total) {
  const filas = items
    .map(
      i => `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #eef0f5; color: #14172b; font-size: 14px;">
            ${i.cantidad}x ${i.nombre}
          </td>
          <td style="padding: 10px 0; border-bottom: 1px solid #eef0f5; color: #14172b; font-size: 14px; text-align: right; white-space: nowrap;">
            $${formatearMoneda(i.precio * i.cantidad)}
          </td>
        </tr>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html>
  <body style="margin: 0; padding: 0; background-color: #f4f5f9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f5f9; padding: 32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 14px; overflow: hidden; max-width: 480px;">
            <tr>
              <td style="background-color: #4f46e5; background-image: linear-gradient(135deg, #6a61ee, #4f46e5); padding: 28px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align: middle;">
                      <img src="cid:botlogo" width="40" height="40" alt="" style="display: block; border-radius: 9px;">
                    </td>
                    <td style="vertical-align: middle; padding-left: 12px;">
                      <span style="color: #ffffff; font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 17px; font-weight: 700;">Bot Mensajería</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 32px;">
                <p style="margin: 0 0 4px; font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 20px; font-weight: 700; color: #14172b;">
                  Nuevo pedido #${pedidoId}
                </p>
                <p style="margin: 0 0 20px; font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 14px; color: #6b7280;">
                  Te llegó un pedido nuevo por WhatsApp.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family: -apple-system, Segoe UI, Arial, sans-serif;">
                  ${filas}
                  <tr>
                    <td style="padding: 16px 0 0; font-size: 15px; font-weight: 700; color: #14172b;">Total</td>
                    <td style="padding: 16px 0 0; font-size: 15px; font-weight: 700; color: #4f46e5; text-align: right;">$${formatearMoneda(total)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 16px 32px; background-color: #f4f5f9;">
                <p style="margin: 0; font-family: -apple-system, Segoe UI, Arial, sans-serif; font-size: 12px; color: #9698b8;">
                  Mensaje automático de Bot Mensajería.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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

  try {
    await transporter.sendMail({
      from: `"Bot Mensajería" <${config.email.gmailUser}>`,
      to: email,
      subject: `Nuevo pedido #${pedidoId}`,
      html: armarHtml(pedidoId, items, total),
      attachments: [
        {
          filename: 'logo.png',
          path: LOGO_PATH,
          cid: 'botlogo',
        },
      ],
    });
    console.log(`[email] Notificación del pedido #${pedidoId} enviada a ${email}`);
  } catch (err) {
    console.error('[email] Error al enviar notificación de pedido:', err.message);
  }
}

module.exports = { enviarNotificacionPedido };
