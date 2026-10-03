# Starter fixtures

`embed.ts` is a byte-for-byte copy of the browser client every site delivered by Contentrain Migrate
ships (`packages/writer/starter/src/lib/studio/embed.ts` in the migrate repo, emitted from
`@contentrain/emitter-astro`). `tests/integration/starter-form-contract.integration.test.ts` runs it against
Studio's real public forms routes, so a change to either side that breaks the other fails here.

Refresh it by copying the file again when the starter's client changes; do not edit it in place.
