# FluidDCA Automation Add-on

This add-on automates DCA (Dollar Cost Averaging) execution for the FluidDCA smart contract on Ethereum Mainnet.

## Features

- Automated EURe to USDC/WETH swaps via 1inch
- Configurable execution schedule (5 minutes to 24 hours)
- MQTT sensors for monitoring DCA status
- Notifications on successful transactions and errors
- Dry run mode for testing
- Gas cost protection (blocks execution if gas > $0.50)

## Prerequisites

1. **Deployed FluidDCA Contract**: You need a deployed FluidDCA contract address
2. **Alchemy API Key**: Sign up at [alchemy.com](https://www.alchemy.com/) for Ethereum Mainnet RPC
3. **1inch API Key**: Get one from the [1inch Developer Portal](https://portal.1inch.dev/)
4. **Executor Wallet**: A wallet with ETH for gas (NOT the EURe holder wallet)
5. **MQTT Broker** (optional): For sensor publishing, install the Mosquitto add-on

## Configuration

### Required Settings

| Option | Description |
|--------|-------------|
| `dca_address` | Your deployed FluidDCA contract address (0x...) |
| `alchemy_api_key` | Alchemy API key for Ethereum Mainnet |
| `oneinch_api_key` | 1inch Developer Portal API key |
| `private_key` | Executor wallet private key (for gas payments) |

### Optional Settings

| Option | Default | Description |
|--------|---------|-------------|
| `schedule_minutes` | 60 | Check interval in minutes (5-1440) |
| `dry_run` | false | Simulate without sending transactions |
| `gas_manager_policy_id` | "" | Alchemy Gas Manager policy ID |
| `mqtt_sensors` | true | Publish status to MQTT |
| `log_level` | info | Logging verbosity |
| `notify_on_success` | true | Send notification on successful tx |
| `notify_on_error` | true | Send notification on failure |
| `notify_service` | "" | Custom notify service (e.g., `notify.matrix_notify`) |

## MQTT Sensors

When enabled, the add-on creates these sensors via MQTT Discovery:

- `sensor.fluiddca_status` - Current status (success/waiting/error)
- `sensor.fluiddca_last_execution` - Timestamp of last execution
- `binary_sensor.fluiddca_can_execute` - Whether execution is possible

## Security Considerations

1. **Executor Wallet**: Use a dedicated wallet with minimal ETH balance. This wallet pays gas fees but does NOT hold the EURe being swapped.

2. **Private Key Storage**: The private key is stored encrypted in Home Assistant's add-on config storage and written to `/run/secrets/` at runtime (not exposed as environment variable).

3. **Gas Protection**: Transactions are blocked if estimated gas cost exceeds $0.50 USD.

## Troubleshooting

### Add-on won't start

Check the logs for missing configuration. All required fields must be set.

### MQTT sensors not appearing

1. Ensure Mosquitto add-on is installed and running
2. Check that `mqtt_sensors` is enabled
3. Verify MQTT integration is configured in Home Assistant

### Execution failures

1. Check logs for specific error messages
2. Verify API keys are valid
3. Ensure executor wallet has ETH for gas
4. Try dry run mode first to test configuration

### Gas too high

The add-on blocks execution if gas cost exceeds $0.50. Wait for lower gas prices or adjust the schedule to check less frequently.

## Support

For issues with this add-on, check the logs first. For FluidDCA contract issues, refer to the main repository.
