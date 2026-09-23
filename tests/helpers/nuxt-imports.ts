/**
 * `#imports` for the unit/integration projects, which run outside Nuxt.
 *
 * Without an alias the specifier does not resolve at all, so `vi.mock('#imports')`
 * cannot even be declared by a test that loads an `ee/` module importing
 * Nitro helpers from it. With this alias it resolves — and a test that mocks
 * it gets its factory, never this file.
 *
 * Everything else keeps the old behaviour: importing it fails, exactly as an
 * unresolved `#imports` did, so code paths that degrade when an `ee/` module
 * cannot load (the enterprise bridge resolving to null) are unchanged.
 */
throw new Error('#imports is only available inside Nuxt/Nitro — vi.mock(\'#imports\') in the test that needs it')
