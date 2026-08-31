import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITIES,
  CAPABILITIES_BY_ID,
  matchCapability,
} from '../src/api/capabilities.js';
import {
  ApiError,
  createHttpApiError,
  normalizeApiError,
} from '../src/api/errors.js';
import { clientCapabilityBindings } from '../src/api/client.js';
import { mobileRequest } from '../src/data/mobile/router.js';

const REQUIRED_FIELDS = [
  'id',
  'method',
  'pathTemplate',
  'query',
  'body',
  'response',
  'successStatus',
  'errors',
  'transaction',
  'platform',
];

function androidExamplePath(pathTemplate) {
  return pathTemplate
    .replace(/\{[^}]*date[^}]*\}/gi, '2026-08-31')
    .replace(/\{[^}]+\}/g, '1');
}

function examplePath(pathTemplate) {
  return pathTemplate.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(`${name}-42`));
}

test('manifest contains exactly 65 complete, uniquely addressable capabilities', () => {
  assert.equal(CAPABILITIES.length, 65);
  assert.equal(CAPABILITIES_BY_ID.size, 65);

  const methodPaths = new Set();
  for (const capability of CAPABILITIES) {
    for (const field of REQUIRED_FIELDS) assert.ok(Object.hasOwn(capability, field), `${capability.id} missing ${field}`);
    assert.match(capability.id, /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/);
    assert.match(capability.method, /^(GET|POST|PUT|DELETE)$/);
    assert.ok(capability.pathTemplate.startsWith('/'));
    assert.equal(typeof capability.response, 'string');
    assert.ok(Number.isInteger(capability.successStatus));
    assert.ok(Array.isArray(capability.errors));
    assert.deepEqual(capability.platform, { web: 'required', android: 'required' });

    const key = `${capability.method} ${capability.pathTemplate}`;
    assert.ok(!methodPaths.has(key), `duplicate method/path contract: ${key}`);
    methodPaths.add(key);
  }
});

test('every manifest path round-trips through the method/pathname matcher', () => {
  for (const capability of CAPABILITIES) {
    const path = `${examplePath(capability.pathTemplate)}/?ignored=true`;
    const match = matchCapability(capability.method.toLowerCase(), path);
    assert.ok(match, `no matcher result for ${capability.id}`);
    assert.equal(match.capability.id, capability.id);
  }
});

test('matcher gives static routes priority over dynamic id routes', () => {
  assert.equal(matchCapability('GET', '/todos/focusing')?.capability.id, 'todos.focusing');
  assert.equal(matchCapability('GET', '/schedules/current')?.capability.id, 'schedules.current');
  assert.equal(matchCapability('GET', '/schedules/week/?start_date=2026-08-17')?.capability.id, 'schedules.week');
  assert.equal(matchCapability('POST', '/recurrence-rules/from-todo/9/sync')?.capability.id, 'recurrence.syncTodo');
  assert.equal(matchCapability('POST', '/timer/12/schedule')?.capability.id, 'timer.attachSchedule');
  assert.equal(matchCapability('GET', '/logs/2026-08-19')?.params.logDate, '2026-08-19');
  assert.equal(matchCapability('PATCH', '/todos/1'), null);
});

test('all public client methods have a unique manifest binding', () => {
  const bindings = Object.entries(clientCapabilityBindings).flatMap(([group, methods]) => (
    Object.entries(methods).map(([method, capabilityId]) => ({ group, method, capabilityId }))

  ));
  const boundIds = bindings.map((binding) => binding.capabilityId);

  assert.equal(bindings.length, 65);
  assert.equal(new Set(boundIds).size, 65, 'a capability is bound by more than one public method');
  assert.deepEqual(new Set(boundIds), new Set(CAPABILITIES.map((item) => item.id)));
  for (const binding of bindings) {
    assert.ok(CAPABILITIES_BY_ID.has(binding.capabilityId), `${binding.group}.${binding.method} has an unknown binding`);
  }
});

test('every manifest capability is claimed by the Android adapter', async () => {
  const missing = [];

  for (const capability of CAPABILITIES) {
    const path = androidExamplePath(capability.pathTemplate);
    try {
      await mobileRequest(path, { method: capability.method, body: '{}' });
    } catch (error) {
      if (error?.status === 501 || error?.code === 'NOT_IMPLEMENTED') {
        missing.push(`${capability.method} ${path}`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Android adapter routes fell through to NOT_IMPLEMENTED: ${missing.join(', ')}`,
  );
});

test('ApiError preserves HTTP validation details and derives a stable code', () => {
  const detail = [{ loc: ['body', 'name'], msg: '不能为空', type: 'value_error' }];
  const error = createHttpApiError({
    status: 422,
    statusText: 'Unprocessable Entity',
    payload: { detail },
    capabilityId: 'projects.create',
  });

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 422);
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.equal(error.detail, detail);
  assert.deepEqual(error.fieldErrors[0], {
    path: 'name',
    location: ['body', 'name'],
    message: '不能为空',
    code: 'value_error',
  });
  assert.equal(error.capabilityId, 'projects.create');
});

test('network and abort failures normalize to ApiError', () => {
  const network = normalizeApiError(new TypeError('fetch failed'), {
    capabilityId: 'health.check',
    defaultCode: 'NETWORK_ERROR',
  });
  const abortedSource = new Error('aborted');
  abortedSource.name = 'AbortError';
  const aborted = normalizeApiError(abortedSource, { capabilityId: 'health.check' });

  assert.equal(network.code, 'NETWORK_ERROR');
  assert.equal(network.status, 0);
  assert.equal(aborted.code, 'REQUEST_ABORTED');
  assert.equal(aborted.capabilityId, 'health.check');
});
