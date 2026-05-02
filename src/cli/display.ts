import chalk from "chalk";

export function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
  ┌─────────────────────────────────────┐
  │         Floe Agent CLI              │
  │   DeFi Lending on Base Mainnet      │
  └─────────────────────────────────────┘
`)
  );
}

export function printSessionInfo(info: {
  address: string;
  walletType: string;
  aiProvider: string;
  aiModel: string;
  toolCount: number;
}): void {
  const { address, walletType, aiProvider, aiModel, toolCount } = info;
  console.log(chalk.dim("─".repeat(50)));
  console.log(`  ${chalk.bold("Wallet:")}     ${address}`);
  console.log(`  ${chalk.bold("Type:")}       ${walletType}`);
  console.log(`  ${chalk.bold("Network:")}    Base Mainnet`);
  console.log(`  ${chalk.bold("AI:")}         ${aiProvider} (${aiModel})`);
  console.log(`  ${chalk.bold("Tools:")}      ${toolCount} actions available`);
  console.log(chalk.dim("─".repeat(50)));
  console.log();
}

export function printHelp(): void {
  console.log(`
  ${chalk.bold("Commands:")}
    ${chalk.cyan("exit")}     Quit the agent
    ${chalk.cyan("help")}     Show this help message
    ${chalk.cyan("wallet")}   Show wallet info
    ${chalk.cyan("clear")}    Clear conversation history
    ${chalk.cyan("config")}   Show current configuration
    ${chalk.cyan("save")}     Save current config for next time
    ${chalk.cyan("history")}  Show session transaction log

  ${chalk.bold("Tips:")}
    - Ask about markets, loans, prices, or intents
    - The AI will confirm before executing write operations
    - Transaction hashes link to BaseScan
    - Use 'history' to see all on-chain actions in this session
`);
}

export function formatTxLink(hash: string): string {
  return `${chalk.cyan(hash)}\n  ${chalk.dim(`https://basescan.org/tx/${hash}`)}`;
}
