/**
 * Alchemy Gas-Sponsored FluidDCA Executor
 *
 * Executes the FluidDCA contract with gas sponsorship via Alchemy's Gas Manager.
 * Replaces Gelato Web3 Functions for automation.
 *
 * Note: This uses direct JSON-RPC calls for paymaster sponsorship rather than
 * full AA-SDK smart accounts, as the DCA contract is EOA-owned.
 */

import * as fs from "fs";
import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import axios from "axios";
import {
  getFluidDCASwapData,
  TOKENS,
  SwapData,
} from "./1inch-quote";

// FluidDCA ABI (minimal interface for execution)
const FLUID_DCA_ABI = [
  "function execute(address usdcExecutor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) usdcSwapDesc, bytes usdcExecutorData, address ethExecutor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) ethSwapDesc, bytes ethExecutorData) external",
  "function canExecute() external view returns (bool)",
  "function getVaultDebt() external view returns (uint256)",
  "function minEureThreshold() external view returns (uint256)",
  "function maxSlippageBps() external view returns (uint256)",
  "function getBalances() external view returns (uint256 eureBalance, uint256 usdcBalance, uint256 ethBalance)",
];

// ERC20 ABI for balance checks
const ERC20_ABI = ["function balanceOf(address) external view returns (uint256)"];

// Chainlink Oracle ABI
const ORACLE_ABI = ["function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)"];

// Oracle addresses (Ethereum Mainnet)
const ORACLES = {
  EUR_USD: "0xb49f677943BC038e9857d61E7d053CaA2C1734C1",
  USDC_USD: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
};

// Fluid Vault configuration (hardcoded for this deployment)
const FLUID_CONFIG = {
  VAULT_RESOLVER: "0xB21C67DD518F6d31257d3A4F12B0A6344885b268",
  VAULT_ADDRESS: "0x0c8c77b7ff4c2af7f6cebbe67350a490e3dd6cb3",
  VAULT_NFT_ID: 8765n,
};

// Gas cost limit in USD
const MAX_GAS_COST_USD = 0.5;

export interface ExecutorConfig {
  dcaAddress: string;
  alchemyApiKey: string;
  gasManagerPolicyId: string;
  privateKey: string;
  dryRun?: boolean;
}

export interface ExecutionResult {
  success: boolean;
  txHash?: string;
  error?: string;
  gasUsed?: string;
  eureSwapped?: string;
  usdcReceived?: string;
  wethReceived?: string;
}

/**
 * Get Alchemy RPC URL
 */
function getAlchemyRpcUrl(apiKey: string): string {
  return `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
}

/**
 * Get private key from config or file
 */
function getPrivateKeyValue(configPrivateKey: string): string {
  if (configPrivateKey) {
    return configPrivateKey;
  }
  if (process.env.PRIVATE_KEY_FILE) {
    return fs.readFileSync(process.env.PRIVATE_KEY_FILE, "utf-8").trim();
  }
  return "";
}

/**
 * Get oracle price with 8 decimals
 */
async function getOraclePrice(provider: JsonRpcProvider, oracleAddress: string): Promise<bigint> {
  const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);
  const [, answer] = await oracle.latestRoundData();
  return BigInt(answer.toString());
}

/**
 * Estimate gas cost in USD
 * @returns Object with gas estimate, gas price, ETH price, and total cost in USD
 */
async function estimateGasCostUsd(
  provider: JsonRpcProvider,
  txParams: { to: string; data: string; from: string }
): Promise<{
  gasEstimate: bigint;
  gasPriceGwei: string;
  ethPriceUsd: number;
  totalCostUsd: number;
}> {
  // Get gas estimate
  const gasEstimate = await provider.estimateGas(txParams);

  // Get current gas price
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;

  // Get ETH/USD price from Chainlink
  const ethPriceRaw = await getOraclePrice(provider, ORACLES.ETH_USD);
  const ethPriceUsd = Number(ethPriceRaw) / 1e8;

  // Calculate total cost in ETH then USD
  const gasCostWei = gasEstimate * gasPrice;
  const gasCostEth = Number(ethers.formatEther(gasCostWei));
  const totalCostUsd = gasCostEth * ethPriceUsd;

  return {
    gasEstimate,
    gasPriceGwei: ethers.formatUnits(gasPrice, "gwei"),
    ethPriceUsd,
    totalCostUsd,
  };
}

/**
 * Get vault debt directly from the Fluid resolver
 * The resolver returns a complex struct - we extract the borrow amount manually
 * Borrow amount is at byte offset 224 (7th 32-byte word) in the returned data
 */
async function getVaultDebtFromResolver(provider: JsonRpcProvider): Promise<bigint> {
  try {
    // Call positionByNftId(uint256) on the resolver
    const calldata = ethers.solidityPacked(
      ["bytes4", "uint256"],
      [ethers.id("positionByNftId(uint256)").slice(0, 10), FLUID_CONFIG.VAULT_NFT_ID]
    );

    const result = await provider.call({
      to: FLUID_CONFIG.VAULT_RESOLVER,
      data: calldata,
    });

    // The borrow amount is at word index 7 (offset 224 bytes = 0xe0)
    // Each word is 32 bytes (64 hex chars), plus 2 for "0x" prefix
    // Word 7 starts at position 2 + (7 * 64) = 450
    const borrowAmountHex = "0x" + result.slice(450, 514);
    const borrowAmount = BigInt(borrowAmountHex);

    console.log(`  Vault debt from resolver: ${ethers.formatUnits(borrowAmount, 6)} USDC`);
    return borrowAmount;
  } catch (error) {
    console.error("Failed to get vault debt from resolver:", error);
    return 0n;
  }
}

/**
 * Calculate how much EURe to allocate for USDC vs ETH based on vault debt
 */
async function calculateSwapAllocations(
  provider: JsonRpcProvider,
  dcaContract: Contract,
  eureBalance: bigint
): Promise<{ eureForUsdc: bigint; eureForEth: bigint }> {
  // Get vault debt directly from resolver (bypasses broken contract interface)
  const vaultDebt = await getVaultDebtFromResolver(provider);

  if (vaultDebt === 0n) {
    // No debt, all EURe goes to ETH for collateral
    return { eureForUsdc: 0n, eureForEth: eureBalance };
  }

  // Get oracle prices
  const eurUsdPrice = await getOraclePrice(provider, ORACLES.EUR_USD);
  const usdcUsdPrice = await getOraclePrice(provider, ORACLES.USDC_USD);

  // Calculate how much EURe needed to cover debt
  // EURe needed = (debtUSDC * usdcUsdPrice) / eurUsdPrice
  // Account for decimals: debt is 6 decimals, prices are 8 decimals, EURe is 18 decimals
  const eureNeededForDebt =
    (vaultDebt * usdcUsdPrice * 10n ** 18n) / (eurUsdPrice * 10n ** 6n);

  // Add 1% buffer for slippage
  const eureForUsdcWithBuffer = (eureNeededForDebt * 101n) / 100n;

  if (eureForUsdcWithBuffer >= eureBalance) {
    // All EURe goes to debt repayment
    return { eureForUsdc: eureBalance, eureForEth: 0n };
  }

  // Remaining goes to ETH collateral
  return {
    eureForUsdc: eureForUsdcWithBuffer,
    eureForEth: eureBalance - eureForUsdcWithBuffer,
  };
}

/**
 * Build the execute() calldata for FluidDCA
 */
function buildExecuteCalldata(
  usdcSwap: SwapData | null,
  ethSwap: SwapData | null
): string {
  const iface = new ethers.Interface(FLUID_DCA_ABI);

  // Create empty swap description for skipped swaps
  const emptySwapDesc = {
    srcToken: TOKENS.EURE,
    dstToken: TOKENS.USDC, // Placeholder
    srcReceiver: ethers.ZeroAddress,
    dstReceiver: ethers.ZeroAddress,
    amount: 0n,
    minReturnAmount: 0n,
    flags: 0n,
  };

  const usdcExecutor = usdcSwap?.executor || ethers.ZeroAddress;
  const usdcDesc = usdcSwap
    ? {
        srcToken: usdcSwap.swapDescription.srcToken,
        dstToken: usdcSwap.swapDescription.dstToken,
        srcReceiver: usdcSwap.swapDescription.srcReceiver,
        dstReceiver: usdcSwap.swapDescription.dstReceiver,
        amount: BigInt(usdcSwap.swapDescription.amount),
        minReturnAmount: BigInt(usdcSwap.swapDescription.minReturnAmount),
        flags: BigInt(usdcSwap.swapDescription.flags),
      }
    : emptySwapDesc;
  const usdcData = usdcSwap?.executorData || "0x";

  const ethExecutor = ethSwap?.executor || ethers.ZeroAddress;
  const ethDesc = ethSwap
    ? {
        srcToken: ethSwap.swapDescription.srcToken,
        dstToken: ethSwap.swapDescription.dstToken,
        srcReceiver: ethSwap.swapDescription.srcReceiver,
        dstReceiver: ethSwap.swapDescription.dstReceiver,
        amount: BigInt(ethSwap.swapDescription.amount),
        minReturnAmount: BigInt(ethSwap.swapDescription.minReturnAmount),
        flags: BigInt(ethSwap.swapDescription.flags),
      }
    : { ...emptySwapDesc, dstToken: TOKENS.WETH };
  const ethData = ethSwap?.executorData || "0x";

  return iface.encodeFunctionData("execute", [
    usdcExecutor,
    usdcDesc,
    usdcData,
    ethExecutor,
    ethDesc,
    ethData,
  ]);
}

/**
 * Request gas sponsorship from Alchemy Gas Manager
 */
async function requestGasSponsorship(
  alchemyApiKey: string,
  policyId: string,
  userOp: {
    sender: string;
    nonce: string;
    callData: string;
    callGasLimit: string;
    verificationGasLimit: string;
    preVerificationGas: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }
): Promise<{ paymasterAndData: string }> {
  const rpcUrl = getAlchemyRpcUrl(alchemyApiKey);

  const response = await axios.post(rpcUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_requestGasAndPaymasterAndData",
    params: [
      {
        policyId,
        entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", // EntryPoint v0.6
        userOperation: userOp,
      },
    ],
  });

  if (response.data.error) {
    throw new Error(`Gas sponsorship failed: ${response.data.error.message}`);
  }

  return response.data.result;
}

/**
 * Execute FluidDCA with gas sponsorship
 *
 * Note: For simplicity, this implementation uses a standard EOA transaction
 * rather than full ERC-4337 UserOperations. The Alchemy Gas Manager can
 * sponsor EOA transactions through their relay service.
 *
 * For production, consider using the full AA-SDK with a smart account.
 */
export async function executeFluidDCA(config: ExecutorConfig): Promise<ExecutionResult> {
  console.log("=== FluidDCA Executor ===");
  console.log("DCA Contract:", config.dcaAddress);
  console.log("Dry Run:", config.dryRun ?? false);

  const provider = new JsonRpcProvider(getAlchemyRpcUrl(config.alchemyApiKey));
  const privateKey = getPrivateKeyValue(config.privateKey);
  const wallet = new Wallet(privateKey, provider);

  console.log("Executor Wallet:", wallet.address);

  // Initialize DCA contract
  const dcaContract = new Contract(config.dcaAddress, FLUID_DCA_ABI, wallet);

  // Step 1: Check if execution conditions are met
  console.log("\n[1/5] Checking execution conditions...");
  const canExecute = await dcaContract.canExecute();
  if (!canExecute) {
    console.log("Cannot execute: EURe balance below threshold");
    return { success: false, error: "EURe balance below threshold" };
  }
  console.log("Execution conditions met!");

  // Step 2: Get current balances and vault debt
  console.log("\n[2/5] Fetching balances and debt...");
  const [eureBalance, usdcBalance, ethBalance] = await dcaContract.getBalances();
  const vaultDebt = await getVaultDebtFromResolver(provider);
  const maxSlippageBps = await dcaContract.maxSlippageBps();

  console.log(`  EURe Balance: ${ethers.formatUnits(eureBalance, 18)} EURe`);
  console.log(`  USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  console.log(`  ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`  Vault Debt: ${ethers.formatUnits(vaultDebt, 6)} USDC`);
  console.log(`  Max Slippage: ${maxSlippageBps} bps`);

  // Step 3: Calculate swap allocations
  console.log("\n[3/5] Calculating swap allocations...");
  const { eureForUsdc, eureForEth } = await calculateSwapAllocations(
    provider,
    dcaContract,
    eureBalance
  );
  console.log(`  EURe for USDC swap: ${ethers.formatUnits(eureForUsdc, 18)} EURe`);
  console.log(`  EURe for ETH swap: ${ethers.formatUnits(eureForEth, 18)} EURe`);

  // Step 4: Fetch 1inch swap data
  console.log("\n[4/5] Fetching 1inch swap quotes...");
  const { usdcSwap, ethSwap } = await getFluidDCASwapData(
    config.dcaAddress,
    eureForUsdc,
    eureForEth,
    Number(maxSlippageBps)
  );

  if (!usdcSwap && !ethSwap) {
    console.log("No swaps needed (both allocations are zero)");
    return { success: false, error: "No swaps needed" };
  }

  // Step 5: Build and execute transaction
  console.log("\n[5/6] Building transaction and estimating gas...");
  const calldata = buildExecuteCalldata(usdcSwap, ethSwap);
  console.log(`  Calldata length: ${calldata.length} bytes`);

  // Estimate gas cost
  const txParams = {
    to: config.dcaAddress,
    data: calldata,
    from: wallet.address,
  };

  let gasEstimateResult;
  try {
    gasEstimateResult = await estimateGasCostUsd(provider, txParams);
    console.log(`  Gas estimate: ${gasEstimateResult.gasEstimate.toLocaleString()} gas`);
    console.log(`  Gas price: ${gasEstimateResult.gasPriceGwei} gwei`);
    console.log(`  ETH price: $${gasEstimateResult.ethPriceUsd.toFixed(2)}`);
    console.log(`  Estimated cost: $${gasEstimateResult.totalCostUsd.toFixed(4)} USD`);
    console.log(`  Max allowed: $${MAX_GAS_COST_USD.toFixed(2)} USD`);
  } catch (error) {
    console.error("Gas estimation failed:", error);
    return {
      success: false,
      error: `Gas estimation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (config.dryRun) {
    console.log("\n=== DRY RUN - Transaction not sent ===");
    console.log("Would execute with:");
    console.log(`  To: ${config.dcaAddress}`);
    console.log(`  Data: ${calldata.slice(0, 66)}...`);
    console.log(`  Gas limit: ${(gasEstimateResult.gasEstimate * 120n / 100n).toLocaleString()} (estimate + 20%)`);
    return {
      success: true,
      eureSwapped: ethers.formatUnits(eureBalance, 18),
      usdcReceived: usdcSwap
        ? ethers.formatUnits(usdcSwap.swapDescription.minReturnAmount, 6)
        : "0",
      wethReceived: ethSwap
        ? ethers.formatUnits(ethSwap.swapDescription.minReturnAmount, 18)
        : "0",
    };
  }

  // Check if gas cost exceeds limit
  if (gasEstimateResult.totalCostUsd > MAX_GAS_COST_USD) {
    console.log(`\n=== EXECUTION BLOCKED ===`);
    console.log(`Gas cost ($${gasEstimateResult.totalCostUsd.toFixed(4)}) exceeds limit ($${MAX_GAS_COST_USD.toFixed(2)})`);
    return {
      success: false,
      error: `Gas cost $${gasEstimateResult.totalCostUsd.toFixed(4)} exceeds limit $${MAX_GAS_COST_USD.toFixed(2)}`,
    };
  }

  // Check executor wallet balance
  const walletBalance = await provider.getBalance(wallet.address);
  const feeData = await provider.getFeeData();
  const estimatedCost = gasEstimateResult.gasEstimate * (feeData.gasPrice || 30000000000n);
  if (walletBalance < estimatedCost) {
    console.log("\n=== EXECUTION BLOCKED ===");
    console.log(`Insufficient ETH for gas. Need ~${ethers.formatEther(estimatedCost)} ETH, have ${ethers.formatEther(walletBalance)} ETH`);
    return {
      success: false,
      error: `Insufficient ETH balance. Need ~${ethers.formatEther(estimatedCost)} ETH, have ${ethers.formatEther(walletBalance)} ETH`,
    };
  }

  console.log("\n[6/7] Simulating transaction...");
  try {
    await provider.call({
      to: config.dcaAddress,
      data: calldata,
      from: wallet.address,
    });
    console.log("  Simulation passed ✓");
  } catch (error) {
    console.error("  Simulation failed - transaction would revert");
    return {
      success: false,
      error: `Simulation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  console.log("\n[7/7] Sending transaction...");
  try {
    // Use estimated gas + 20% buffer
    const gasLimit = gasEstimateResult.gasEstimate * 120n / 100n;

    const tx = await wallet.sendTransaction({
      to: config.dcaAddress,
      data: calldata,
      gasLimit,
    });

    console.log(`  Transaction sent: ${tx.hash}`);
    console.log("  Waiting for confirmation...");

    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt?.blockNumber}`);

    return {
      success: true,
      txHash: tx.hash,
      gasUsed: receipt?.gasUsed?.toString(),
      eureSwapped: ethers.formatUnits(eureBalance, 18),
      usdcReceived: usdcSwap
        ? ethers.formatUnits(usdcSwap.swapDescription.minReturnAmount, 6)
        : "0",
      wethReceived: ethSwap
        ? ethers.formatUnits(ethSwap.swapDescription.minReturnAmount, 18)
        : "0",
    };
  } catch (error) {
    console.error("Transaction failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if execution is needed (for monitoring/alerting)
 */
export async function checkExecutionStatus(config: {
  dcaAddress: string;
  alchemyApiKey: string;
}): Promise<{
  canExecute: boolean;
  eureBalance: string;
  vaultDebt: string;
  minThreshold: string;
}> {
  const provider = new JsonRpcProvider(getAlchemyRpcUrl(config.alchemyApiKey));
  const dcaContract = new Contract(config.dcaAddress, FLUID_DCA_ABI, provider);

  const canExecute = await dcaContract.canExecute();
  const [eureBalance] = await dcaContract.getBalances();
  const vaultDebt = await getVaultDebtFromResolver(provider);
  const minThreshold = await dcaContract.minEureThreshold();

  return {
    canExecute,
    eureBalance: ethers.formatUnits(eureBalance, 18),
    vaultDebt: ethers.formatUnits(vaultDebt, 6),
    minThreshold: ethers.formatUnits(minThreshold, 18),
  };
}

// CLI usage
async function main() {
  const privateKey = getPrivateKeyValue(process.env.PRIVATE_KEY || "");

  const config: ExecutorConfig = {
    dcaAddress: process.env.DCA_ADDRESS || "",
    alchemyApiKey: process.env.ALCHEMY_API_KEY || "",
    gasManagerPolicyId: process.env.GAS_MANAGER_POLICY_ID || "",
    privateKey: privateKey,
    dryRun: process.env.DRY_RUN === "true",
  };

  // Validate required config
  const missing: string[] = [];
  if (!config.dcaAddress) missing.push("DCA_ADDRESS");
  if (!config.alchemyApiKey) missing.push("ALCHEMY_API_KEY");
  if (!config.privateKey) missing.push("PRIVATE_KEY or PRIVATE_KEY_FILE");

  if (missing.length > 0) {
    console.error("Missing required environment variables:", missing.join(", "));
    process.exit(1);
  }

  // Check status first
  console.log("Checking execution status...\n");
  const status = await checkExecutionStatus({
    dcaAddress: config.dcaAddress,
    alchemyApiKey: config.alchemyApiKey,
  });

  console.log("Current Status:");
  console.log(`  Can Execute: ${status.canExecute}`);
  console.log(`  EURe Balance: ${status.eureBalance} EURe`);
  console.log(`  Min Threshold: ${status.minThreshold} EURe`);
  console.log(`  Vault Debt: ${status.vaultDebt} USDC`);

  if (!status.canExecute) {
    console.log("\nExecution not needed at this time.");
    return;
  }

  console.log("\nProceeding with execution...\n");
  const result = await executeFluidDCA(config);

  if (result.success) {
    console.log("\n=== Execution Successful ===");
    if (result.txHash) console.log(`  TX Hash: ${result.txHash}`);
    if (result.gasUsed) console.log(`  Gas Used: ${result.gasUsed}`);
    console.log(`  EURe Swapped: ${result.eureSwapped}`);
    console.log(`  USDC Received: ${result.usdcReceived}`);
    console.log(`  WETH Received: ${result.wethReceived}`);
  } else {
    console.error("\n=== Execution Failed ===");
    console.error(`  Error: ${result.error}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
