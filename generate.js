const fs = require("fs/promises");

async function generateConfig() {
  const config = await fs.readFile('./config.json');

  await fs.mkdir('./src/generated', { recursive: true });
  
  await fs.writeFile('./src/generated/index.js', [
    `const config = ${config}`,
    `module.exports = config;`
  ].join('\n'));
};

generateConfig().then(() => console.log('Config generated'));
