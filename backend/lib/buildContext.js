// The tar a build sends to the Docker daemon.
//
// The panel packs the context itself (tar-fs), so a .dockerignore only takes
// effect on the daemon's side, after every file was already read here. A
// runtime that knows part of its context must not be read — Git App's .git,
// which git rewrites when it packs objects — names it in `exclude` and those
// paths are never opened.

const path = require('path');
const tar = require('tar-fs');

// True for an excluded path and anything below it.
function isExcluded(name, exclude) {
  const target = path.resolve(name);
  return exclude.some(p => target === p || target.startsWith(p + path.sep));
}

function packContext(dir, { exclude = [] } = {}) {
  const skip = exclude.map(p => path.resolve(p));
  return tar.pack(dir, skip.length ? { ignore: name => isExcluded(name, skip) } : {});
}

module.exports = { packContext, isExcluded };
