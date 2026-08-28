// Fail early and clearly when run under a Node too old to execute TypeScript.
//
// Without this the failure surfaces as ERR_UNKNOWN_FILE_EXTENSION from the ESM
// loader, which says nothing about the actual cause. With nvm installed the shell
// default is easily an older release than the one the project needs.
const MINIMUM = 24;
const major = Number(process.versions.node.split(".")[0]);

if (major < MINIMUM) {
  console.error(
    `\nprinter-mcp needs Node ${MINIMUM}+ to run TypeScript directly.\n` +
    `You are on Node ${process.versions.node} (${process.execPath}).\n\n` +
    `Fix it with:  nvm use\n` +
    `(the required version is pinned in .nvmrc)\n`,
  );
  process.exit(1);
}
