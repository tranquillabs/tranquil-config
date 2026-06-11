require('dotenv').config();

const keys = {
    staging: {
        posthog_key: process.env.POSTHOG_KEY_STAGING,
        github_token: process.env.GITHUB_TOKEN_STAGING,
    },
    production: {
        posthog_key: process.env.POSTHOG_KEY_PRODUCTION,
        github_token: process.env.GITHUB_TOKEN_PRODUCTION,
    },
};

module.exports = {
    keys,
};
