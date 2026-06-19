module.exports = {
  activate() {
    atom.config.setDefaults('tree-view', {
      hideIgnoredNames: true,
      hideVcsIgnoredFiles: true,
    });
  }
};
