# Monarch Modules

`Monarch Modules` is a promoted suite for first-party modules and a guided module builder.

The `suite` kind affects grouping, navigation, and dependency lifecycle only. It never bypasses routing, permission gates, audit, filesystem policy, or Security.

The builder follows a review-first flow:

1. validate a structured draft;
2. preview every generated file;
3. create an isolated module folder after write confirmation;
4. review tests and explicitly register the package in `src/modules/catalog.ts`.

Generated scaffolds never overwrite an existing module and never modify the catalog automatically.
