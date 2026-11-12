// Each image serves only its own role; other roles' modules in this tree are not deployable.
const role=process.argv[2];if(role!=='core')throw Error('This image runs only: node server.mjs core');await import('./core.mjs');
