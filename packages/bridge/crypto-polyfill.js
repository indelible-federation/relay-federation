// Web Crypto polyfill — must load before @bsv/sdk.
//
// @bsv/sdk's Random.js probes `globalThis.crypto.getRandomValues` for a secure
// RNG. Its documented `require('crypto')` fallback for older Node is dead code
// under ESM (where `require` is undefined and throws into a swallowed catch), so
// on any Node build that doesn't expose the Web Crypto API as a global, the SDK
// falls through to a stub that throws:
//
//   "No secure random number generator is available in this environment."
//
// the instant a key is generated (e.g. PrivateKey.fromRandom). That is issue #8.
//
// Importing this module first installs the Web Crypto global from node:crypto, so
// the SDK's primary code path resolves on every supported Node version.
import { webcrypto } from 'node:crypto'

if (typeof globalThis.crypto?.getRandomValues !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
  })
}
