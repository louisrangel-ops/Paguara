import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReturnUrl } from '../../src/payment-intents/payment-intents.service';

test('return_url: vacía es null; https siempre; http solo en pruebas', () => {
  assert.equal(parseReturnUrl(undefined, true), null);
  assert.equal(parseReturnUrl('', true), null);
  assert.equal(parseReturnUrl('https://tienda.com/pedido?id=7', true), 'https://tienda.com/pedido?id=7');
  assert.equal(parseReturnUrl('http://localhost:8080/?wc-api=paguara', false), 'http://localhost:8080/?wc-api=paguara');
  assert.throws(() => parseReturnUrl('http://tienda.com/', true), /https/);
});

test('return_url: rechaza lo que no es una URL web limpia', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,hola', '/relativa', 'https://user:clave@tienda.com/', 42, 'https://t.com/' + 'a'.repeat(2048)]) {
    assert.throws(() => parseReturnUrl(bad, false), (e: { code?: string }) => e.code === 'return_url_invalid', String(bad));
  }
});
