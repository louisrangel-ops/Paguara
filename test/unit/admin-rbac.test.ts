import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operatorPermissions } from '../../src/settlements/operators.service';

test('RBAC interno: master tiene control total y auditor es solo lectura', () => {
  const master = operatorPermissions('master');
  assert.ok(master.includes('operators:manage'));
  assert.ok(master.includes('iso8583:manage'));
  assert.ok(master.includes('treasury:contribute'));

  const auditor = operatorPermissions('auditor');
  assert.ok(auditor.includes('merchants:read'));
  assert.ok(auditor.includes('operators:read'));
  assert.ok(!auditor.includes('merchants:status'));
  assert.ok(!auditor.includes('capabilities:manage'));
});

test('RBAC interno: cumplimiento, operaciones y tesoreria quedan separados', () => {
  const compliance = operatorPermissions('compliance');
  assert.ok(compliance.includes('iso8583:manage'));
  assert.ok(compliance.includes('merchants:status'));
  assert.ok(!compliance.includes('treasury:contribute'));

  const operations = operatorPermissions('operations');
  assert.ok(operations.includes('capabilities:manage'));
  assert.ok(operations.includes('platform:manage'));
  assert.ok(!operations.includes('payouts:approve'));

  const treasury = operatorPermissions('treasury');
  assert.ok(treasury.includes('payouts:approve'));
  assert.ok(treasury.includes('settlement:manage'));
  assert.ok(!treasury.includes('iso8583:manage'));
});

test('RBAC interno: doble factor, secretos de los bancos, conciliación y alertas', () => {
  const master = operatorPermissions('master');
  for (const p of ['security:manage', 'secrets:manage', 'reconciliation:run', 'alerts:ack'] as const) assert.ok(master.includes(p));
  assert.ok(!operatorPermissions('compliance').includes('reconciliation:read'));
  assert.ok(operatorPermissions('treasury').includes('reconciliation:run'));
  const auditor = operatorPermissions('auditor');
  assert.ok(auditor.includes('reconciliation:read') && auditor.includes('alerts:read') && auditor.includes('secrets:read'));
  assert.ok(!auditor.includes('reconciliation:run') && !auditor.includes('alerts:ack') && !auditor.includes('secrets:manage'));
  for (const role of ['operator', 'compliance', 'operations', 'treasury', 'support', 'auditor'] as const) {
    assert.ok(!operatorPermissions(role).includes('security:manage'), `${role} no reinicia doble factor`);
    assert.ok(!operatorPermissions(role).includes('secrets:manage'), `${role} no carga secretos de bancos`);
  }
});
