const chalk = require('chalk');
const { getConfig, setConfig, getConfigPath } = require('../config/manager');
const logger = require('../utils/logger');

async function configShowCommand() {
  const config = getConfig();

  console.log(chalk.bold('Glad Configuration:'));
  console.log('');
  console.log(chalk.bold.cyan('User Settings:'));
  console.log(`  Default AI:     ${config.defaultAI || '(auto-detect)'}`);
  console.log('');
  console.log(chalk.bold.cyan('System:'));
  console.log(`  Config file:    ${chalk.gray(getConfigPath())}`);
  console.log(`  Last updated:   ${config.lastUpdated || 'Never'}`);
  console.log('');
  console.log(`To change settings: ${chalk.cyan('glad config set <key> <value>')}`);
}

async function configGetCommand(key) {
  if (!key) {
    return configShowCommand();
  }

  const value = getConfig(key);

  if (value === undefined) {
    console.error(chalk.red(`Unknown config key: ${key}`));
    console.error('');
    console.error('Available keys: defaultAI');
    return;
  }

  console.log(value);
}

async function configSetCommand(key, value) {
  if (!key || !value) {
    console.error(chalk.red('Usage: glad config set <key> <value>'));
    console.error('');
    console.error('Examples:');
    console.error(chalk.cyan('  glad config set defaultAI aider'));
    return;
  }

  const validKeys = ['defaultAI'];

  if (!validKeys.includes(key)) {
    console.error(chalk.red(`Invalid config key: ${key}`));
    console.error('');
    console.error(`Valid keys: ${validKeys.join(', ')}`);
    return;
  }

  setConfig(key, value);
  logger.success(`Config updated: ${key} = ${value}`);
}

async function configCommand(action, key, value) {
  if (!action) {
    return configShowCommand();
  }

  switch (action) {
    case 'get':
      await configGetCommand(key);
      break;

    case 'set':
      await configSetCommand(key, value);
      break;

    default:
      await configGetCommand(action);
  }
}

module.exports = configCommand;
