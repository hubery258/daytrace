import test from 'node:test';
import assert from 'node:assert/strict';

import { encryptCasPassword } from '../src/data/mobile/zjuNetwork.js';

test('CAS RSA password transform matches the backend implementation', () => {
  assert.equal(
    encryptCasPassword('abc', '10001', 'd5bbb96d30086ec484eba3d7f9caeb07'),
    '683778f1339a14c6a09f019b9eedfbcb',
  );
});

test('CAS RSA transform rejects malformed public keys without echoing credentials', () => {
  assert.throws(
    () => encryptCasPassword('do-not-echo', 'bad-key', '1234'),
    (error) => error.code === 'ZJU_CAS_KEY_INVALID' && !error.message.includes('do-not-echo'),
  );
});
