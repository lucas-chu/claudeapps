// The project has no ambient `*.css` module declaration (see the existing,
// pre-existing `src/main.tsx` styles.css import error), so this side-effect
// import needs its own narrow declaration rather than widening that gap
// project-wide.
declare module '@excalidraw/excalidraw/index.css'
