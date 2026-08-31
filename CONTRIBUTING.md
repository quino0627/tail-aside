# Contributing

Thanks for helping make mobile access to Aside safer and more useful.

## Local workflow

1. Fork and clone the repository.
2. Install Node.js 22.12 or newer and run `npm install`.
3. Use `npm run dev` for the frontend and `npm start` for the local API.
4. Run `npm run check` before opening a pull request.

Keep the production server bound to localhost. New write endpoints must use the existing authorization and state-change guards. Never add a public-hosting shortcut or commit real Aside transcripts, Tailscale identities, local paths, or credentials.

For UI changes, test at a 390 × 844 mobile viewport and a desktop viewport. Verify text selection, textarea focus without viewport zoom, safe-area padding, session continuation, and the no-JavaScript-error state.

Small, focused pull requests are easiest to review. Explain any behavior change and include tests when changing config parsing, authorization, CLI arguments, or session state.
