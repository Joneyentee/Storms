// Obsidian writes [[Page\|Alias]] in frontmatter, but \| is an invalid YAML
// escape sequence. This custom engine strips \| before parsing. Shared between
// Eleventy's frontmatter parsing (.eleventy.js) and the summary generation
// build step so both read notes identically.
const jsYamlForMatter = require(require.resolve("js-yaml", { paths: [require.resolve("gray-matter")] }));

const matterOptions = {
  engines: {
    yaml: {
      parse: (str) => jsYamlForMatter.load(str.replace(/\\\|/g, "|")),
      stringify: (obj) => jsYamlForMatter.dump(obj),
    },
  },
};

module.exports = { matterOptions };
