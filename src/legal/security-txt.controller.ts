import { Controller, Get, Header, NotFoundException } from '@nestjs/common';

/**
 * /.well-known/security.txt (RFC 9116): dónde reportar una vulnerabilidad.
 * Solo se publica si SECURITY_CONTACT está definida (un mailto: o una URL https),
 * para no anunciar un contacto que nadie lee. La política vive en #/legal/seguridad.
 */
@Controller('.well-known')
export class SecurityTxtController {
  @Get('security.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  securityTxt(): string {
    const contact = process.env.SECURITY_CONTACT?.trim();
    if (!contact || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(contact)) throw new NotFoundException();
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    // Vence al año: RFC 9116 pide revisar el archivo al menos una vez al año
    const expires = new Date(Date.now() + 365 * 86400_000);
    expires.setUTCHours(0, 0, 0, 0);
    return [
      `Contact: ${contact}`,
      `Expires: ${expires.toISOString()}`,
      'Preferred-Languages: es, en',
      ...(base ? [`Policy: ${base}/#/legal/seguridad`, `Canonical: ${base}/.well-known/security.txt`] : []),
      '',
    ].join('\n');
  }
}
