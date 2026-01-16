#!/usr/bin/env npx ts-node
/**
 * FluidDCA Execution Runner
 *
 * Standalone script to execute the FluidDCA contract with Alchemy gas sponsorship.
 * Can be run manually or via cron job for automated execution.
 *
 * Usage:
 *   npx ts-node run-execution.ts [--dry-run] [--check-only]
 *
 * Environment Variables:
 *   DCA_ADDRESS - FluidDCA contract address (required)
 *   ALCHEMY_API_KEY - Alchemy API key for RPC (required)
 *   PRIVATE_KEY or PRIVATE_KEY_FILE - Executor wallet private key (required for execution)
 *   ONEINCH_API_KEY - 1inch API key for swap quotes (required for execution)
 *   GAS_MANAGER_POLICY_ID - Alchemy Gas Manager policy ID (optional)
 *   DRY_RUN - Set to "true" to simulate without sending tx
 */

import * as fs from "fs";
import { executeFluidDCA, checkExecutionStatus, ExecutorConfig } from "./alchemy-executor";

interface CliArgs {
  dryRun: boolean;
  checkOnly: boolean;
  help: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run") || process.env.DRY_RUN === "true",
    checkOnly: args.includes("--check-only"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function printUsage(): void {
  console.log(`
FluidDCA Execution Runner

Usage:
  npx ts-node run-execution.ts [options]

Options:
  --dry-run      Simulate execution without sending transaction
  --check-only   Only check if execution is needed, don't execute
  -h, --help     Show this help message

Environment Variables (create .env file or export):
  DCA_ADDRESS           FluidDCA contract address (required)
  ALCHEMY_API_KEY       Alchemy API key for RPC (required)
  PRIVATE_KEY           Executor wallet private key (required for execution)
  PRIVATE_KEY_FILE      Alternative: path to file containing private key
  ONEINCH_API_KEY       1inch API key for swap quotes (required for execution)
  GAS_MANAGER_POLICY_ID Alchemy Gas Manager policy ID (optional)

Examples:
  # Check if execution is needed
  npx ts-node run-execution.ts --check-only

  # Dry run (simulate execution)
  npx ts-node run-execution.ts --dry-run

  # Execute for real
  npx ts-node run-execution.ts

Cron Job Setup:
  # Run every hour
  0 * * * * cd /path/to/automation && npx ts-node run-execution.ts >> /var/log/fluiddca.log 2>&1
`);
}

/**
 * Get private key from environment variable or file
 */
function getPrivateKey(): string {
  if (process.env.PRIVATE_KEY) {
    return process.env.PRIVATE_KEY;
  }
  if (process.env.PRIVATE_KEY_FILE) {
    return fs.readFileSync(process.env.PRIVATE_KEY_FILE, "utf-8").trim();
  }
  return "";
}

function validateEnvironment(checkOnly: boolean): { valid: boolean; missing: string[] } {
  const required = ["DCA_ADDRESS", "ALCHEMY_API_KEY"];
  if (!checkOnly) {
    required.push("ONEINCH_API_KEY");
  }

  const missing = required.filter((key) => !process.env[key]);

  // Check for private key (either env var or file)
  if (!checkOnly && !getPrivateKey()) {
    missing.push("PRIVATE_KEY or PRIVATE_KEY_FILE");
  }

  return { valid: missing.length === 0, missing };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  console.log("==========================================");
  console.log("       FluidDCA Execution Runner");
  console.log("==========================================");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${args.checkOnly ? "Check Only" : args.dryRun ? "Dry Run" : "Live Execution"}`);
  console.log("");

  // Validate environment
  const { valid, missing } = validateEnvironment(args.checkOnly);
  if (!valid) {
    console.error("Missing required environment variables:");
    missing.forEach((key) => console.error(`  - ${key}`));
    console.error("\nRun with --help for usage information.");
    process.exit(1);
  }

  const dcaAddress = process.env.DCA_ADDRESS!;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY!;

  console.log(`DCA Contract: ${dcaAddress}`);
  console.log("");

  try {
    // Always check status first
    console.log("[Status Check]");
    const status = await checkExecutionStatus({ dcaAddress, alchemyApiKey });

    console.log(`  Can Execute: ${status.canExecute ? "YES" : "NO"}`);
    console.log(`  EURe Balance: ${status.eureBalance} EURe`);
    console.log(`  Min Threshold: ${status.minThreshold} EURe`);
    console.log(`  Vault Debt: ${status.vaultDebt} USDC`);
    console.log("");

    if (args.checkOnly) {
      console.log("Check complete. Exiting.");
      process.exit(status.canExecute ? 0 : 2); // Exit code 2 = no action needed
    }

    if (!status.canExecute) {
      console.log("Execution not needed. EURe balance below threshold.");
      process.exit(2);
    }

    // Proceed with execution
    console.log("[Execution]");
    const config: ExecutorConfig = {
      dcaAddress,
      alchemyApiKey,
      gasManagerPolicyId: process.env.GAS_MANAGER_POLICY_ID || "",
      privateKey: getPrivateKey(),
      dryRun: args.dryRun,
    };

    const result = await executeFluidDCA(config);

    console.log("");
    console.log("==========================================");
    if (result.success) {
      console.log("         EXECUTION SUCCESSFUL");
      console.log("==========================================");
      if (result.txHash) {
        console.log(`TX Hash: ${result.txHash}`);
        console.log(`Etherscan: https://etherscan.io/tx/${result.txHash}`);
      }
      if (result.gasUsed) {
        console.log(`Gas Used: ${result.gasUsed}`);
      }
      console.log(`EURe Swapped: ${result.eureSwapped} EURe`);
      console.log(`USDC Received: ${result.usdcReceived} USDC`);
      console.log(`WETH Received: ${result.wethReceived} WETH`);
      process.exit(0);
    } else {
      console.log("         EXECUTION FAILED");
      console.log("==========================================");
      console.log(`Error: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error("");
    console.error("==========================================");
    console.error("         UNEXPECTED ERROR");
    console.error("==========================================");
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error("");
      console.error("Stack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run
main();
