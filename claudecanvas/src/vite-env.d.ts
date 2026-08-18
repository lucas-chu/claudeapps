/// <reference types="vite/client" />

// Vite's client types declare the ambient modules for side-effect asset
// imports (`*.css` among them). Without this reference `npm run typecheck`
// fails on every stylesheet import even though Vite resolves them fine, so
// the build and the typechecker disagreed about the same file.
