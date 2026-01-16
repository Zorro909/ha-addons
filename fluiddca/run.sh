#!/usr/bin/with-contenv bashio

# Graceful shutdown handling
SHUTDOWN=false
trap 'SHUTDOWN=true; bashio::log.info "Shutdown signal received..."' SIGTERM SIGINT

# Read configuration
DCA_ADDRESS=$(bashio::config 'dca_address')
ALCHEMY_API_KEY=$(bashio::config 'alchemy_api_key')
ONEINCH_API_KEY=$(bashio::config 'oneinch_api_key')
PRIVATE_KEY=$(bashio::config 'private_key')
SCHEDULE_MINUTES=$(bashio::config 'schedule_minutes')
DRY_RUN=$(bashio::config 'dry_run')
GAS_MANAGER_POLICY_ID=$(bashio::config 'gas_manager_policy_id')
MQTT_SENSORS=$(bashio::config 'mqtt_sensors')
LOG_LEVEL=$(bashio::config 'log_level')
NOTIFY_ON_SUCCESS=$(bashio::config 'notify_on_success')
NOTIFY_ON_ERROR=$(bashio::config 'notify_on_error')
NOTIFY_SERVICE=$(bashio::config 'notify_service')

# Write private key to secrets file (not env var for security)
mkdir -p /run/secrets
echo -n "${PRIVATE_KEY}" > /run/secrets/private_key
chmod 600 /run/secrets/private_key

# Export environment variables (except PRIVATE_KEY)
export DCA_ADDRESS
export ALCHEMY_API_KEY
export ONEINCH_API_KEY
export DRY_RUN
export GAS_MANAGER_POLICY_ID
export NOTIFY_ON_SUCCESS
export NOTIFY_ON_ERROR
export NOTIFY_SERVICE
export PRIVATE_KEY_FILE="/run/secrets/private_key"

# Set log level
bashio::log.level "${LOG_LEVEL}"

bashio::log.info "FluidDCA Automation starting..."
bashio::log.info "Contract: ${DCA_ADDRESS}"
bashio::log.info "Schedule: Every ${SCHEDULE_MINUTES} minutes"
bashio::log.info "Dry run: ${DRY_RUN}"

# Initialize MQTT sensors if enabled
if bashio::var.true "${MQTT_SENSORS}"; then
    if bashio::services.available "mqtt"; then
        bashio::log.info "Initializing MQTT sensors..."
        /usr/local/bin/mqtt-sensors.sh init
    else
        bashio::log.warning "MQTT sensors enabled but MQTT service not available"
    fi
fi

# Retry wrapper with exponential backoff
run_with_retry() {
    local max_attempts=3
    local attempt=1
    local delays=(30 60 120)

    while [ $attempt -le $max_attempts ]; do
        if "$@"; then
            return 0
        fi
        local exit_code=$?

        # Exit code 2 = balance below threshold (not a retry-able error)
        if [ $exit_code -eq 2 ]; then
            return 2
        fi

        if [ $attempt -lt $max_attempts ]; then
            local delay=${delays[$((attempt-1))]}
            bashio::log.warning "Attempt $attempt failed, retrying in ${delay}s..."
            sleep $delay
        fi
        ((attempt++))
    done
    return 1
}

# Main loop
while [ "$SHUTDOWN" = false ]; do
    bashio::log.info "Running DCA check..."

    cd /app || exit 1

    # Determine arguments
    EXEC_ARGS=()
    if bashio::var.true "${DRY_RUN}"; then
        EXEC_ARGS+=(--dry-run)
    fi

    # Capture output for notification details
    EXEC_OUTPUT=$(mktemp)

    # Run execution with retry
    run_with_retry npx ts-node run-execution.ts "${EXEC_ARGS[@]}" 2>&1 | tee "${EXEC_OUTPUT}"
    EXIT_CODE=${PIPESTATUS[0]}

    if [ $EXIT_CODE -eq 0 ]; then
        bashio::log.info "DCA check completed successfully"
        LAST_STATUS="success"

        # Send success notification
        if bashio::var.true "${NOTIFY_ON_SUCCESS}"; then
            /usr/local/bin/notify.sh success "${EXEC_OUTPUT}"
        fi
    elif [ $EXIT_CODE -eq 2 ]; then
        bashio::log.info "DCA execution not needed (balance below threshold)"
        LAST_STATUS="waiting"
    else
        bashio::log.error "DCA execution failed after retries with code ${EXIT_CODE}"
        LAST_STATUS="error"

        # Send error notification
        if bashio::var.true "${NOTIFY_ON_ERROR}"; then
            /usr/local/bin/notify.sh error "${EXEC_OUTPUT}" "${EXIT_CODE}"
        fi
    fi

    rm -f "${EXEC_OUTPUT}"

    # Update MQTT sensors
    if bashio::var.true "${MQTT_SENSORS}" && bashio::services.available "mqtt"; then
        /usr/local/bin/mqtt-sensors.sh update "${LAST_STATUS}"
    fi

    # Check for shutdown before sleeping
    if [ "$SHUTDOWN" = true ]; then
        break
    fi

    # Sleep until next run (interruptible)
    SLEEP_SECONDS=$((SCHEDULE_MINUTES * 60))
    bashio::log.info "Sleeping for ${SCHEDULE_MINUTES} minutes..."
    sleep "${SLEEP_SECONDS}" &
    wait $!
done

bashio::log.info "FluidDCA Automation stopped gracefully"
