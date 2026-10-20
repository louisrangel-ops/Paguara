import { createHash } from 'node:crypto';
import { CURRENCY_EXPONENT, Currency } from '../common/money';

/** Un movimiento del extracto ya normalizado: monto en unidades mínimas, crédito > 0. */
export interface BankMovement {
  valueDate: string;
  amount: bigint;
  reference: string;
  description?: string;
}

const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_VE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function parseDate(v: string): string {
  const s = v.trim();
  const iso = DATE_ISO.exec(s);
  const ve = DATE_VE.exec(s);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : ve ? [ve[3], ve[2], ve[1]] : [];
  if (!y) throw new Error(`Fecha inválida "${v}": usa AAAA-MM-DD o DD/MM/AAAA`);
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) throw new Error(`Fecha inválida "${v}"`);
  return `${y}-${m}-${d}`;
}

/**
 * Monto decimal del banco a unidades mínimas, sin pasar por float. Acepta
 * "3650.00", "3650,00", "3.650,00" y "3,650.00": si hay punto y coma, el último
 * es el decimal. Negativo = débito.
 */
export function parseAmount(v: string, currency: Currency): bigint {
  let s = v.trim().replace(/\s/g, '');
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  s = s.replace(/^[-+(]|\)$/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const decimalSep = lastDot >= 0 && lastComma >= 0 ? (lastDot > lastComma ? '.' : ',') : lastComma >= 0 ? ',' : '.';
  const thousands = decimalSep === '.' ? ',' : '.';
  s = s.split(thousands).join('');
  const [int, frac = ''] = s.split(decimalSep);
  const exp = CURRENCY_EXPONENT[currency];
  if (!/^\d+$/.test(int) || !/^\d*$/.test(frac) || frac.length > exp) throw new Error(`Monto inválido "${v}" para ${currency}`);
  const minor = BigInt(int) * 10n ** BigInt(exp) + BigInt((frac + '0'.repeat(exp)).slice(0, exp) || '0');
  return neg ? -minor : minor;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const HEADERS: Record<string, keyof BankMovement> = {
  fecha: 'valueDate', fecha_valor: 'valueDate', date: 'valueDate',
  referencia: 'reference', reference: 'reference', ref: 'reference',
  monto: 'amount', amount: 'amount', importe: 'amount',
  descripcion: 'description', 'descripción': 'description', concepto: 'description', description: 'description',
};

/**
 * Extracto genérico en CSV (coma o punto y coma), con encabezado:
 * `fecha;referencia;monto;descripcion`. Cada banco tiene su formato; los que no
 * calcen se convierten a este (o se agrega su parser) antes de importar.
 */
export function parseStatementCsv(text: string, currency: Currency): BankMovement[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitCsvLine(lines[0], sep).map((h) => HEADERS[h.toLowerCase()]);
  for (const need of ['valueDate', 'reference', 'amount'] as const) {
    if (!header.includes(need)) throw new Error('El CSV necesita las columnas fecha, referencia y monto (y opcional descripcion)');
  }
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line, sep);
    const get = (k: keyof BankMovement) => cells[header.indexOf(k)] ?? '';
    try {
      const reference = get('reference');
      if (!reference) throw new Error('falta la referencia');
      return { valueDate: parseDate(get('valueDate')), amount: parseAmount(get('amount'), currency), reference: reference.slice(0, 80),
        description: header.includes('description') ? get('description').slice(0, 300) || undefined : undefined };
    } catch (e) {
      throw new Error(`Línea ${i + 2}: ${(e as Error).message}`);
    }
  });
}

export const contentHash = (movements: BankMovement[]) =>
  createHash('sha256').update(JSON.stringify(movements.map((m) => [m.valueDate, m.amount.toString(), m.reference, m.description ?? '']))).digest('hex');
