/**
 * 1inch Aggregation Protocol Quote Fetcher
 *
 * Fetches swap quotes from the 1inch API v6 for use with FluidDCA contract execution.
 * Replaces the previous Velora integration to align with the contract's 1inch router.
 */

import axios, { AxiosError } from "axios";
import { ethers } from "ethers";

// Token addresses (Ethereum Mainnet)
export const TOKENS = {
  EURE: "0x39b8B6385416f4cA36a20319F70D28621895279D",
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
};

// 1inch API configuration
const ONEINCH_API_BASE = "https://api.1inch.dev/swap/v6.0";
const CHAIN_ID = 1; // Ethereum Mainnet

// 1inch Aggregation Router V6 address
export const AGGREGATION_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";

export interface SwapQuote {
  srcToken: string;
  dstToken: string;
  srcAmount: string;
  dstAmount: string;
  protocols: string[][];
  gas: number;
}

export interface SwapTransaction {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: number;
  gasPrice: string;
}

export interface SwapData {
  quote: SwapQuote;
  tx: SwapTransaction;
  // Parsed data for FluidDCA.execute() SwapDescription
  executor: string;
  executorData: string;
  swapDescription: {
    srcToken: string;
    dstToken: string;
    srcReceiver: string;
    dstReceiver: string;
    amount: string;
    minReturnAmount: string;
    flags: string;
  };
}

/**
 * Get 1inch API headers with authentication
 */
function getHeaders(): Record<string, string> {
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    throw new Error("ONEINCH_API_KEY environment variable is required");
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Get a swap quote from 1inch API (price estimation only)
 */
export async function get1inchQuote(params: {
  src: string;
  dst: string;
  amount: string;
  includeProtocols?: boolean;
}): Promise<SwapQuote> {
  const url = `${ONEINCH_API_BASE}/${CHAIN_ID}/quote`;
  const queryParams = {
    src: params.src,
    dst: params.dst,
    amount: params.amount,
    includeProtocols: params.includeProtocols ?? true,
  };

  console.log("Fetching 1inch quote...");
  console.log(`  From: ${params.src}`);
  console.log(`  To: ${params.dst}`);
  console.log(`  Amount: ${params.amount}`);

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      params: queryParams,
      timeout: 30000, // 30 second timeout
    });

    const data = response.data;
    return {
      srcToken: data.srcToken,
      dstToken: data.dstToken,
      srcAmount: data.srcAmount,
      dstAmount: data.dstAmount,
      protocols: data.protocols || [],
      gas: data.gas || 0,
    };
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("1inch API error:", error.response?.data || error.message);
    }
    throw error;
  }
}

/**
 * Get swap transaction data from 1inch API
 * This returns the full transaction data needed for execution
 */
export async function get1inchSwapData(params: {
  src: string;
  dst: string;
  amount: string;
  from: string;
  receiver: string;
  slippage: number; // e.g., 0.5 for 0.5%
  disableEstimate?: boolean;
}): Promise<SwapData> {
  const url = `${ONEINCH_API_BASE}/${CHAIN_ID}/swap`;
  const queryParams = {
    src: params.src,
    dst: params.dst,
    amount: params.amount,
    from: params.from,
    receiver: params.receiver,
    slippage: params.slippage,
    disableEstimate: params.disableEstimate ?? true, // Contract will estimate
    allowPartialFill: false, // Require full swap
  };

  console.log("Fetching 1inch swap data...");
  console.log(`  From token: ${params.src}`);
  console.log(`  To token: ${params.dst}`);
  console.log(`  Amount: ${params.amount}`);
  console.log(`  Receiver: ${params.receiver}`);
  console.log(`  Slippage: ${params.slippage}%`);

  try {
    const response = await axios.get(url, {
      headers: getHeaders(),
      params: queryParams,
      timeout: 30000, // 30 second timeout
    });

    const data = response.data;

    // Parse the transaction data to extract executor and executorData
    // The 1inch swap() function signature: swap(IAggregationExecutor executor, SwapDescription desc, bytes data)
    const { executor, executorData, swapDescription } = parseSwapCalldata(
      data.tx.data,
      params.receiver
    );

    return {
      quote: {
        srcToken: data.srcToken,
        dstToken: data.dstToken,
        srcAmount: data.srcAmount,
        dstAmount: data.dstAmount,
        protocols: data.protocols || [],
        gas: data.tx.gas || 0,
      },
      tx: {
        from: data.tx.from,
        to: data.tx.to,
        data: data.tx.data,
        value: data.tx.value,
        gas: data.tx.gas,
        gasPrice: data.tx.gasPrice,
      },
      executor,
      executorData,
      swapDescription,
    };
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("1inch API error:", error.response?.data || error.message);
    }
    throw error;
  }
}

/**
 * Parse 1inch swap calldata to extract executor, description, and data
 * The swap function selector is 0x12aa3caf
 */
function parseSwapCalldata(
  calldata: string,
  expectedReceiver: string
): {
  executor: string;
  executorData: string;
  swapDescription: SwapData["swapDescription"];
} {
  // 1inch AggregationRouterV6 swap function
  const swapInterface = new ethers.Interface([
    "function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes data)",
  ]);

  try {
    const decoded = swapInterface.decodeFunctionData("swap", calldata);

    const executor = decoded[0] as string;
    const desc = decoded[1];
    const executorData = decoded[2] as string;

    // Validate dstReceiver matches expected - CRITICAL security check
    if (desc.dstReceiver.toLowerCase() !== expectedReceiver.toLowerCase()) {
      throw new Error(
        `CRITICAL: dstReceiver mismatch! Expected ${expectedReceiver}, got ${desc.dstReceiver}. Aborting to prevent fund loss.`
      );
    }

    return {
      executor,
      executorData,
      swapDescription: {
        srcToken: desc.srcToken,
        dstToken: desc.dstToken,
        srcReceiver: desc.srcReceiver,
        dstReceiver: desc.dstReceiver,
        amount: desc.amount.toString(),
        minReturnAmount: desc.minReturnAmount.toString(),
        flags: desc.flags.toString(),
      },
    };
  } catch (error) {
    console.error("Failed to parse 1inch calldata:", error);
    throw new Error("Invalid 1inch swap calldata format");
  }
}

/**
 * Get quotes for both EURe->USDC and EURe->WETH swaps for FluidDCA execution
 */
export async function getFluidDCASwapData(
  dcaContractAddress: string,
  eureForUsdc: bigint,
  eureForEth: bigint,
  slippageBps: number // e.g., 50 for 0.5%
): Promise<{
  usdcSwap: SwapData | null;
  ethSwap: SwapData | null;
}> {
  const slippagePercent = slippageBps / 100; // Convert bps to percent

  let usdcSwap: SwapData | null = null;
  let ethSwap: SwapData | null = null;

  if (eureForUsdc > 0n) {
    console.log("\n=== EURe -> USDC Swap ===");
    usdcSwap = await get1inchSwapData({
      src: TOKENS.EURE,
      dst: TOKENS.USDC,
      amount: eureForUsdc.toString(),
      from: dcaContractAddress,
      receiver: dcaContractAddress,
      slippage: slippagePercent,
    });
    console.log(`  Expected USDC: ${ethers.formatUnits(usdcSwap.quote.dstAmount, 6)}`);
  }

  if (eureForEth > 0n) {
    console.log("\n=== EURe -> WETH Swap ===");
    ethSwap = await get1inchSwapData({
      src: TOKENS.EURE,
      dst: TOKENS.WETH,
      amount: eureForEth.toString(),
      from: dcaContractAddress,
      receiver: dcaContractAddress,
      slippage: slippagePercent,
    });
    console.log(`  Expected WETH: ${ethers.formatUnits(ethSwap.quote.dstAmount, 18)}`);
  }

  return { usdcSwap, ethSwap };
}

// CLI usage
async function main() {
  const dcaAddress = process.env.DCA_ADDRESS;
  const eureAmount = process.env.EURE_AMOUNT || "50000000000000000000"; // 50 EURe default

  if (!dcaAddress) {
    console.error("Please set DCA_ADDRESS environment variable");
    process.exit(1);
  }

  if (!process.env.ONEINCH_API_KEY) {
    console.error("Please set ONEINCH_API_KEY environment variable");
    process.exit(1);
  }

  console.log("FluidDCA Contract:", dcaAddress);
  console.log("EURe Amount:", ethers.formatUnits(eureAmount, 18), "EURe");

  try {
    // For demo, split 50/50 between USDC and ETH
    const halfAmount = BigInt(eureAmount) / 2n;

    const { usdcSwap, ethSwap } = await getFluidDCASwapData(
      dcaAddress,
      halfAmount,
      halfAmount,
      50 // 0.5% slippage
    );

    console.log("\n=== Swap Data Summary ===");
    if (usdcSwap) {
      console.log("USDC Swap:");
      console.log("  Executor:", usdcSwap.executor);
      console.log("  Min Return:", ethers.formatUnits(usdcSwap.swapDescription.minReturnAmount, 6), "USDC");
    }
    if (ethSwap) {
      console.log("ETH Swap:");
      console.log("  Executor:", ethSwap.executor);
      console.log("  Min Return:", ethers.formatUnits(ethSwap.swapDescription.minReturnAmount, 18), "WETH");
    }
  } catch (error) {
    console.error("Error fetching quotes:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
