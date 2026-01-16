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
    local exit_code

    while [ $attempt -le $max_attempts ]; do
        # Run command and capture exit code explicitly
        "$@"
        exit_code=$?

        # Exit code 0 = success
        if [ $exit_code -eq 0 ]; then
            return 0
        fi

        # Exit code 2 = balance below threshold (not a retry-able error)
        if [ $exit_code -eq 2 ]; then
            bashio::log.debug "Exit code 2: no retry needed (balance below threshold)"
            return 2
        fi

        # Other failures: retry with backoff
        if [ $attempt -lt $max_attempts ]; then
            local delay=${delays[$((attempt-1))]}
            bashio::log.warning "Attempt $attempt failed (exit code $exit_code), retrying in ${delay}s..."
            sleep "$delay"
        fi
        ((attempt++))
    done

    bashio::log.error "All $max_attempts attempts failed"
    return 1
}

# Main loop
while [ "$SHUTDOWN" = false ]; do
    bashio::log.info "Running DCA check..."

    # Disable errexit for the execution block - bashio enables it by default
    # and we need to handle non-zero exit codes ourselves
    set +e

    # Change to app directory
    if ! cd /app; then
        bashio::log.error "Failed to cd to /app"
        EXIT_CODE=1
        EXEC_OUTPUT=""
    else
        # Determine arguments
        EXEC_ARGS=()
        if bashio::var.true "${DRY_RUN}"; then
            EXEC_ARGS+=(--dry-run)
        fi

        # Capture output for notification details
        EXEC_OUTPUT=$(mktemp)

        # Run execution with retry
        bashio::log.debug "Executing: npx ts-node run-execution.ts ${EXEC_ARGS[*]}"
        run_with_retry npx ts-node run-execution.ts "${EXEC_ARGS[@]}" > "${EXEC_OUTPUT}" 2>&1
        EXIT_CODE=$?

        # Show output in logs
        if [ -f "${EXEC_OUTPUT}" ]; then
            cat "${EXEC_OUTPUT}"
        fi
    fi

    # Re-enable errexit
    set -e

    bashio::log.debug "Execution finished with exit code: ${EXIT_CODE}"

    if [ "$EXIT_CODE" -eq 0 ]; then
        bashio::log.info "DCA transaction executed successfully"
        LAST_STATUS="executed"

        # Send success notification (don't let it fail the loop)
        if bashio::var.true "${NOTIFY_ON_SUCCESS}"; then
            /usr/local/bin/notify.sh success "${EXEC_OUTPUT}" || bashio::log.warning "Failed to send success notification"
        fi
    elif [ "$EXIT_CODE" -eq 2 ]; then
        bashio::log.info "DCA execution not needed (balance below threshold)"
        LAST_STATUS="low_balance"
        # No notification for balance below threshold - this is expected behavior
    else
        bashio::log.error "DCA execution failed with code ${EXIT_CODE}"
        LAST_STATUS="error"

        # Send error notification (don't let it fail the loop)
        if bashio::var.true "${NOTIFY_ON_ERROR}"; then
            /usr/local/bin/notify.sh error "${EXEC_OUTPUT}" "${EXIT_CODE}" || bashio::log.warning "Failed to send error notification"
        fi
    fi

    if [ -n "${EXEC_OUTPUT}" ]; then
        rm -f "${EXEC_OUTPUT}" 2>/dev/null || true
    fi

    # Update MQTT sensors (don't let it fail the loop)
    if bashio::var.true "${MQTT_SENSORS}" && bashio::services.available "mqtt"; then
        /usr/local/bin/mqtt-sensors.sh update "${LAST_STATUS}" || bashio::log.warning "Failed to update MQTT sensors"
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
