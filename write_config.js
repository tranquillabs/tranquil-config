const fs = require('fs');
const { keys } = require('./keys.js');

async function writeConfig() {
  const envFlag = process.argv[2];
  const environment = envFlag === '--production' ? 'production' : envFlag === '--staging' ? 'staging' : null;

  if (!environment) {
    console.error("Invalid or missing environment flag. Use '--production' or '--staging'.");
    process.exit(1);
  }

  try {
    const configData = {
      posthog_key: keys[environment].posthog_key,
      github_token: keys[environment].github_token,
    };

    fs.writeFile('./config.json', JSON.stringify(configData, null, 2), {}, () => {});
  } catch (error) {
    console.error('Error writing config:', error);
    process.exit(1);
  }
}

 writeConfig();
