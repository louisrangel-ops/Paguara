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
