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
  .name('termly')
  .description('Transform your AI terminal tools into a beautiful Web PWA interface')
  .version(packageJson.version, '-v, --version', 'Show version');

// Default Web command
program
  .command('web', { isDefault: true })
  .description('Start the local web server (PWA) to access AI tools')
  .option('-p, --port <number>', 'Port to run the server on', '3000')
  .action(async (options) => {
    await webCommand(options);
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
  console.log('  $ termly                                # Start web server on port 3000');
  console.log('  $ termly --port 8080                    # Start on custom port');
  console.log('');
  console.log('Manage Tools:');
  console.log('  $ termly tools list                     # List all supported tools');
  console.log('  $ termly tools detect                   # Check installed tools');
  console.log('');
  console.log('Supported AI Tools:');
  console.log('  • Claude Code, Aider, GitHub Copilot, Gemini CLI, and more...');
  console.log('');
  console.log('Website: https://termly.dev');
  console.log('');
});

// Parse arguments
program.parse(process.argv);
