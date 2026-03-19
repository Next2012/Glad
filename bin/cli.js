#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const packageJson = require('../package.json');

// Import commands
const webCommand = require('../lib/commands/web');
const toolsCommand = require('../lib/commands/tools');
const configCommand = require('../lib/commands/config');

const program = new Command();

// Configure program
program
  .name('glad')
  .description('Transform your AI terminal tools into a beautiful Web interface')
  .version(packageJson.version, '-v, --version', 'Show version');

// Default Web command
program
  .command('web [directory]', { isDefault: true })
  .description('Start the local web server to access AI tools')
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .action(async (directory, options) => {
    await webCommand({ ...options, directory });
  });

// Tools command
program
  .command('tools <action> [tool-name]')
  .description('Manage AI tools (actions: list, detect, info)')
  .action(async (action, toolName) => {
    await toolsCommand(action, toolName);
  });

// Config command
program
  .command('config [action] [key] [value]')
  .description('Manage configuration (actions: get, set)')
  .action(async (action, key, value) => {
    await configCommand(action, key, value);
  });

// Help command customization
program.on('--help', () => {
  console.log('');
  console.log('Quick Start:');
  console.log('  $ glad                                  # Start web server in current folder');
  console.log('  $ glad /path/to/project                 # Start in specific folder');
  console.log('  $ glad . --port 8080                    # Custom port in current folder');
  console.log('');
  console.log('Manage Tools:');
  console.log('  $ glad tools list                       # List all supported tools');
  console.log('  $ glad tools detect                     # Check installed tools');
  console.log('');
  console.log('Supported AI Tools:');
  console.log('  • Claude Code, Aider, GitHub Copilot, Gemini CLI, and more...');
  console.log('');
  console.log('Source: https://gitee.com/next2012/glad');
  console.log('');
});

// Parse arguments
program.parse(process.argv);
