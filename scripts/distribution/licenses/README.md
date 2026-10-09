# Supplemental dependency notices

Some locked npm packages omit a standalone license file. This directory is copied to the bundle's `resources/third-party`; package metadata and any embedded notices remain alongside each dependency.

- `pi-LICENSE`: Pi v1.1.0 root license for `@earendil-works/pi-ai`, `pi-agent-core` and `pi-telemetry`. Source: https://github.com/earendil-works/pi/blob/v1.1.0/LICENSE
- `aws-sdk-LICENSE`: AWS SDK Apache-2.0 license copied from the locked `@aws-sdk/client-bedrock-runtime` package, also included for the credential-provider and nested-client packages from the same SDK.
- `proxy-agents-LICENSE`: supplemental notice for `proxy-agent-negotiate`, from the same upstream repository's proxy-agent package. Source: https://github.com/TooTallNate/proxy-agents/blob/4813885d3f4e2ff837878ceffdba656a71dc31f0/packages/proxy-agent/LICENSE
- `standard-webhooks-LICENSE`: upstream root license at the npm package's git revision. Source: https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/LICENSE . The npm package retains its own license metadata.
- `data-uri-to-buffer` carries its MIT notice in its bundled README.
