# ATC Ground

A voice-driven air traffic control game: you work ground control (v1: JFK Ground), speaking
instructions to simulated pilots while a simulated ramp and tower handle their sides.

- Product requirements: [`docs/prd/ground-control-v1.md`](docs/prd/ground-control-v1.md)
- Current plan and task breakdown: [`PLAN.md`](PLAN.md) (progress in [`STATUS.md`](STATUS.md))

## Commands

Requires current Node LTS and npm.

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start the Vite dev server for the web app (prints the local URL) |
| `npm test` | Run the Vitest suite once |
| `npm run typecheck` | Type-check every TypeScript project (sim, web, node) |
| `npm run build` | Build the web app into `dist/` |

## Layout

| Path | Contents |
|---|---|
| `src/sim/` | Headless simulation. No DOM APIs: `tsconfig.sim.json` has no DOM lib. |
| `src/airport/` | Airport format, loader and validator. Same no-DOM config as the sim. |
| `src/web/` | Browser app (Vite root; entry `src/web/index.html`). |
| `tools/` | Importers and scripts that run in Node. |
| `data/airports/` | Airport data files. |
| `spikes/` | Throwaway experiments, each its own standalone package. Not part of the root build, type-check or tests. |
