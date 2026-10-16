import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Página de checkout alojada (estilo Stripe Checkout). Se abre con
 * /checkout?pi=<id>&cs=<client_secret>&pk=<llave publicable> y habla solo con
 * /v1/checkout/payment_intents. Sin esos parámetros corre en modo demostración.
 */
@Controller('checkout')
export class CheckoutPageController {
  private readonly html = `<!doctype html><html lang="es"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>`
    + readFileSync(join(process.cwd(), 'public', 'checkout.html'), 'utf8')
    + `</body></html>`;

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer') // el client_secret va en la URL: que no se filtre en el Referer
  page(): string {
    return this.html;
  }
}
