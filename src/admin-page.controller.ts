import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Panel interno (operaciones y cumplimiento): aprobar solicitudes de los comercios,
 * interruptores globales y precio por comercio. La página no trae datos: cada
 * llamada a /internal/* exige el X-Internal-Token que escribe el operador.
 */
@Controller('admin')
export class AdminPageController {
  private readonly html = `<!doctype html><html lang="es"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>`
    + readFileSync(join(process.cwd(), 'public', 'admin.html'), 'utf8')
    + `</body></html>`;

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Header('X-Frame-Options', 'DENY')
  @Header('Referrer-Policy', 'no-referrer')
  page(): string {
    return this.html;
  }
}
