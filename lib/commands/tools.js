const chalk = require('chalk');
const { getAllTools, getToolByKey } = require('../ai-tools/registry');
const { detectInstalledTools } = require('../ai-tools/detector');

async function toolsListCommand() {
  console.log(chalk.bold('Available AI Tools:'));
  console.log('');

  const allTools = getAllTools();
  const installedTools = await detectInstalledTools();

  const installedKeys = new Set(installedTools.map(t => t.key));

  for (const tool of allTools) {
    // Skip demo mode from tools list (it's a special hidden mode)
    if (tool.key === 'demo') {
      continue;
    }

    const isInstalled = installedKeys.has(tool.key);
    const icon = isInstalled ? chalk.green('✓') : chalk.red('✗');
    const status = isInstalled ? chalk.green('installed') : chalk.gray('not installed');

    const installedTool = installedTools.find(t => t.key === tool.key);
    const version = installedTool ? ` v${installedTool.version}` : '';

    console.log(`  ${icon} ${chalk.bold(tool.displayName)} (${tool.command})${version} - ${status}`);
  }

  console.log('');
  console.log(`Use ${chalk.cyan('glad')} and choose a tool from the Web UI, or start Glad in your target directory`);
}

async function toolsDetectCommand() {
  console.log(chalk.bold('🔍 Detecting installed AI tools...'));
  console.log('');

  const installedTools = await detectInstalledTools();

  if (installedTools.length === 0) {
    console.log(chalk.yellow('No AI tools found'));
    console.log('');
    console.log('Install an AI coding assistant:');
    console.log('  • Claude Code: https://docs.claude.com');
    console.log('  • Aider: pip install aider-chat');
    console.log('  • GitHub Copilot: gh extension install github/gh-copilot');
    return;
  }

  console.log(chalk.green(`Found ${installedTools.length} AI tool${installedTools.length > 1 ? 's' : ''}:`));
  console.log('');

  installedTools.forEach(tool => {
    console.log(`  • ${chalk.bold(tool.displayName)} v${tool.version}`);
  });

  console.log('');
  if (installedTools.length === 1) {
    console.log(chalk.cyan(`Recommended: ${installedTools[0].displayName}`));
  }
}

async function toolsInfoCommand(toolName) {
  if (!toolName) {
    console.error(chalk.red('Please specify a tool name'));
    console.error('');
    console.error(`Usage: ${chalk.cyan('glad tools info <tool-name>')}`);
    return;
  }

  const tool = getToolByKey(toolName);

  if (!tool) {
    console.error(chalk.red(`Unknown tool: ${toolName}`));
    console.error('');
    console.error(`Use ${chalk.cyan('glad tools list')} to see available tools`);
    return;
  }

  console.log(chalk.bold(tool.displayName));
  console.log('─'.repeat(tool.displayName.length));
  console.log(`${chalk.gray('Command:')}     ${tool.command}`);
  console.log(`${chalk.gray('Description:')} ${tool.description}`);
  console.log(`${chalk.gray('Website:')}     ${tool.website}`);

  const { isToolInstalled } = require('../ai-tools/detector');
  const result = await isToolInstalled(tool.key);

  if (result.installed) {
    console.log(`${chalk.gray('Installed:')}   ${chalk.green('✓ Yes')} (v${result.tool.version})`);
  } else {
    console.log(`${chalk.gray('Installed:')}   ${chalk.red('✗ No')}`);
  }

  console.log('');
  console.log(chalk.bold('Example usage:'));
  console.log(chalk.cyan(`  glad`));

  if (tool.key === 'aider') {
    console.log(chalk.cyan('  glad /path/to/project'));
  }
}

async function toolsCommand(action, toolName) {
  switch (action) {
    case 'list':
      await toolsListCommand();
      break;

    case 'detect':
      await toolsDetectCommand();
      break;

    case 'info':
      await toolsInfoCommand(toolName);
      break;

    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      console.error('');
      console.error('Available actions:');
      console.error(chalk.cyan('  glad tools list'));
      console.error(chalk.cyan('  glad tools detect'));
      console.error(chalk.cyan('  glad tools info <tool-name>'));
  }
}

module.exports = toolsCommand;
